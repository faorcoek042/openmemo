#!/usr/bin/env bash
#
# 本机跑通 `scripts/ci/buildbox.sh` 与 `scripts/ci/smoke-linux-pack.sh` 的**全部判定逻辑**，
# 不需要 docker，也不需要真的编译。
#
# ## 为什么需要它
#
# T-163 把三条 Linux 腿的编译挪进容器（理由见 buildbox.Dockerfile 的文件头）。
# 这两个脚本里**要验的东西一行都不在 docker 里**：
#   · 哪些目录必须挂进去、少挂一个会不会当场红；
#   · 容器自己的 glibc 高于基线时会不会拒绝继续；
#   · 烟雾测试的那条 `libggml-*` 收窄，会不会被"顺手放宽"成对任何 not found 都报红。
# 而这台开发机上 `which docker` 是空的（lint-workflows.mjs 的文件头也记着这一条），
# **所以只能靠桩**。桩挡不住的部分在下面「覆盖不到」里如实列出。
#
# ## 覆盖到
#   · BUILDBOX_IMAGE 缺失 / docker 不存在 → 红（正向的失败）
#   · 挂载根的组装：workspace / RUNNER_TEMP / CCACHE_DIR / VULKAN_SDK / node bin
#   · ★反向：`$GITHUB_OUTPUT` 落在挂载根之外 → 必须红（"少挂一个目录"那一族）
#   · ★反向：`$VULKAN_SDK` 指向不存在的路径 → 必须红（而不是静默不挂）
#   · --report：容器 glibc ≤ 基线 → 绿；> 基线 → 红；解析不出版本 → 红
#   · smoke：自包含正向、pack_id 为空、加速模块缺失、libggml 解析不到 → 红
#   · ★边界：**不相干的库** not found（libcuda.so.1）→ 必须**绿**
#
# ## 覆盖不到（老实说）
#   真 docker 的行为（`--user` 在真容器里的效果、bind mount 的语义）、
#   真 whisper-cli、真 ldd 对真 .so 的输出。那些只有 CI 上第一次真跑才知道。
#
# 跑：`pnpm test:ci-scripts`
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILDBOX="${SCRIPT_DIR}/buildbox.sh"
SMOKE="${SCRIPT_DIR}/smoke-linux-pack.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/om-buildbox-selftest-XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32m✔\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m✘\033[0m %s\n' "$1"; printf '      %s\n' "${2:-}"; fail=$((fail+1)); }

# ──────────────────────────────────────────────────────────────────────────────
# docker 桩：把整条 argv 记到 $ARGV_LOG，并按 $STUB_MODE 决定 `run` 的输出。
# ──────────────────────────────────────────────────────────────────────────────
make_stub_docker() {
  local dir="$1" mode="$2"
  mkdir -p "${dir}"
  cat > "${dir}/docker" <<STUB
#!/usr/bin/env bash
set -Eeuo pipefail
MODE="${mode}"
STUB
  cat >> "${dir}/docker" <<'STUB'
printf '%s\n' "$*" >> "${ARGV_LOG:?ARGV_LOG 没设}"
case "${MODE}" in
  glibc-235) echo "ldd (Ubuntu GLIBC 2.35-0ubuntu3.10) 2.35"; echo "gcc (Ubuntu 11.4.0) 11.4.0" ;;
  glibc-239) echo "ldd (Ubuntu GLIBC 2.39-0ubuntu8.6) 2.39" ;;
  garbage)   echo "ldd: something went wrong" ;;
  *)         : ;;
esac
STUB
  chmod +x "${dir}/docker"
}

# 一次隔离的调用：自带 workspace / RUNNER_TEMP / CCACHE_DIR。
new_env_dir() {
  local d="${WORK}/env-$1"
  mkdir -p "${d}/ws" "${d}/tmp" "${d}/ccache" "${d}/bin"
  printf '%s' "${d}"
}

echo "① buildbox.sh 的前置条件 —— 缺一个就必须红"
{
  d="$(new_env_dir 1)"; make_stub_docker "${d}/bin" noop
  out="$(env -u BUILDBOX_IMAGE ARGV_LOG="${d}/argv.log" PATH="${d}/bin:${PATH}" \
        GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" \
        bash "${BUILDBOX}" true 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *BUILDBOX_IMAGE* ]]; then ok "BUILDBOX_IMAGE 缺失 → 红"
  else bad "BUILDBOX_IMAGE 缺失应当红" "rc=${rc} out=${out}"; fi

  out="$(BUILDBOX_IMAGE=x DOCKER=definitely-not-a-real-binary ARGV_LOG="${d}/argv.log" \
        GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" \
        bash "${BUILDBOX}" true 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"definitely-not-a-real-binary"* ]]; then ok "宿主没有 docker → 红（而不是悄悄在宿主上编）"
  else bad "docker 不存在应当红" "rc=${rc} out=${out}"; fi

  out="$(BUILDBOX_IMAGE=x ARGV_LOG="${d}/argv.log" PATH="${d}/bin:${PATH}" \
        GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" \
        bash "${BUILDBOX}" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 ]]; then ok "没给要执行的命令 → 红"
  else bad "空命令应当红" "out=${out}"; fi
}

echo "② 挂载与环境的组装（正向）"
{
  d="$(new_env_dir 2)"; make_stub_docker "${d}/bin" noop
  : > "${d}/tmp/gh-output"
  mkdir -p "${d}/sdk/x86_64"
  ARGV="${d}/argv.log"; : > "${ARGV}"
  BUILDBOX_IMAGE=om-box:test ARGV_LOG="${ARGV}" PATH="${d}/bin:${PATH}" \
    GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" CCACHE_DIR="${d}/ccache" \
    VULKAN_SDK="${d}/sdk/x86_64" GITHUB_OUTPUT="${d}/tmp/gh-output" \
    bash "${BUILDBOX}" bash scripts/build-whisper.sh --backend vulkan >/dev/null 2>&1 || true
  argv="$(cat "${ARGV}")"
  for needle in \
      "-v ${d}/ws:${d}/ws" \
      "-v ${d}/tmp:${d}/tmp" \
      "-v ${d}/ccache:${d}/ccache" \
      "-v ${d}/sdk/x86_64:${d}/sdk/x86_64" \
      "--user $(id -u):$(id -g)" \
      "-e GITHUB_OUTPUT=${d}/tmp/gh-output" \
      "-e CCACHE_DIR=${d}/ccache" \
      "-w ${d}/ws" \
      "om-box:test" \
      "bash scripts/build-whisper.sh --backend vulkan" ; do
    if [[ "${argv}" == *"${needle}"* ]]; then ok "docker argv 含 \`${needle}\`"
    else bad "docker argv 少了 \`${needle}\`" "${argv}"; fi
  done
  if [[ -d "${d}/tmp/buildbox-home" ]]; then ok "容器 \$HOME 落在 RUNNER_TEMP 底下（不写宿主的真 HOME）"
  else bad "没建 buildbox-home"; fi
}

echo "③ ★反向：少挂一个目录必须当场红，而不是让某一步对着空气工作"
{
  d="$(new_env_dir 3)"; make_stub_docker "${d}/bin" noop
  mkdir -p "${d}/outside"; : > "${d}/outside/gh-output"
  # $GITHUB_OUTPUT 落在所有挂载根之外 —— 容器里那条路径要么不存在、要么指向容器自己的
  # 临时文件，宿主这边只会读到空的 pack_id / stage_dir。
  out="$(BUILDBOX_IMAGE=x ARGV_LOG="${d}/argv.log" PATH="${d}/bin:${PATH}" \
        GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" \
        GITHUB_OUTPUT="${d}/outside/gh-output" \
        bash "${BUILDBOX}" true 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"不在任何一个挂载根底下"* ]]; then ok "GITHUB_OUTPUT 在挂载根之外 → 红"
  else bad "GITHUB_OUTPUT 在挂载根之外应当红" "rc=${rc} out=${out}"; fi

  # VULKAN_SDK 指向一个不存在的路径：add_mount 会跳过它（optional），
  # 如果没有 is_inside 兜着，就会静默地不挂 → configure 阶段才红，而且信息在别处。
  out="$(BUILDBOX_IMAGE=x ARGV_LOG="${d}/argv.log" PATH="${d}/bin:${PATH}" \
        GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" \
        VULKAN_SDK="${d}/no-such-sdk" \
        bash "${BUILDBOX}" true 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"不在任何一个挂载根底下"* ]]; then ok "VULKAN_SDK 指向不存在的路径 → 红"
  else bad "VULKAN_SDK 不存在应当红" "rc=${rc} out=${out}"; fi
}

echo "④ --report：编译环境自己的 glibc 就是那条基线的第一道闸"
{
  d="$(new_env_dir 4)"
  for mode_expect in "glibc-235:0" "glibc-239:1" "garbage:1"; do
    mode="${mode_expect%%:*}"; want="${mode_expect##*:}"
    bindir="${d}/bin-${mode}"; make_stub_docker "${bindir}" "${mode}"
    out="$(BUILDBOX_IMAGE=x ARGV_LOG="${d}/argv-${mode}.log" PATH="${bindir}:${PATH}" \
          GITHUB_WORKSPACE="${d}/ws" RUNNER_TEMP="${d}/tmp" BUILDBOX_MAX_GLIBC=2.35 \
          bash "${BUILDBOX}" --report 2>&1)" && rc=0 || rc=$?
    if [[ "${rc}" -eq "${want}" ]]; then ok "--report / ${mode} → rc=${rc}（期望 ${want}）"
    else bad "--report / ${mode} 期望 rc=${want}，实得 ${rc}" "${out}"; fi
  done
}

# ──────────────────────────────────────────────────────────────────────────────
# smoke-linux-pack.sh
# ──────────────────────────────────────────────────────────────────────────────
# 造一个"看起来像真包"的目录：whisper-cli 与 libggml-<backend>.so 都用真 ELF
# （`/bin/true` 的副本），这样 `ldd` 与 `--help` 都是真的在跑，不是桩。
make_fake_pack() {
  local root="$1" pack_id="$2" backend="$3" with_module="$4"
  local dir="${root}/${pack_id}"
  mkdir -p "${dir}"
  cp /bin/true "${dir}/whisper-cli"
  cp /bin/true "${dir}/libggml-base.so.0"
  [[ "${with_module}" == "yes" ]] && cp /bin/true "${dir}/libggml-${backend}.so"
  tar czf "${root}/${pack_id}.tar.gz" -C "${root}" "${pack_id}"
  rm -rf "${dir}"
  printf '%s' "${root}/${pack_id}.tar.gz"
}

make_stub_ldd() {
  local dir="$1" extra="$2"
  mkdir -p "${dir}"
  cat > "${dir}/ldd" <<STUB
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "ldd (Ubuntu GLIBC 2.35-0ubuntu3.10) 2.35"; exit 0; fi
echo "	linux-vdso.so.1 (0x00007ffd)"
${extra}
echo "	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f00)"
STUB
  chmod +x "${dir}/ldd"
}

echo "⑤ smoke-linux-pack.sh 正向 + 反向"
{
  d="${WORK}/smoke"; mkdir -p "${d}"

  arch="$(make_fake_pack "${d}" whispercpp-vulkan-linux-x64 vulkan yes)"
  out="$(bash "${SMOKE}" --archive "${arch}" --pack-id whispercpp-vulkan-linux-x64 \
        --backend vulkan --workdir "${d}/w1" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -eq 0 && "${out}" == *"pack is relocatable"* ]]; then ok "自包含的加速包 → 绿"
  else bad "正向用例应当绿" "rc=${rc} out=${out}"; fi

  out="$(bash "${SMOKE}" --archive "${arch}" --pack-id "" --backend vulkan 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"pack_id"* ]]; then ok "★反向：pack_id 为空 → 红（空 id 会让后面每条断言对着空气工作）"
  else bad "空 pack_id 应当红" "rc=${rc} out=${out}"; fi

  arch2="$(make_fake_pack "${d}/nomod" whispercpp-vulkan-linux-x64 vulkan no)"
  mkdir -p "${d}/nomod"
  out="$(bash "${SMOKE}" --archive "${arch2}" --pack-id whispercpp-vulkan-linux-x64 \
        --backend vulkan --workdir "${d}/w2" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"加速包没有加速器"* ]]; then ok "★反向：叫 vulkan 但里面没有 libggml-vulkan.so → 红"
  else bad "缺加速模块应当红" "rc=${rc} out=${out}"; fi

  # ★反向：模块自己的 libggml-* 依赖解析不到（D-11 §8.4 第 2 条的形状）
  #
  # 桩**刻意吐很多条 `not found`**。T-161 的内联实现是
  #   `ldd "$mod" | grep 'not found' | grep -q 'libggml'`
  # `grep -q` 一命中就退出 → 中间那个 `grep` 写不下去拿到 SIGPIPE → `pipefail` 把整条
  # 管道判成 141（非零）→ `if` 为**假** → **该报的红被吞掉**。
  #
  # `[本机实测]` 阈值（匹配行数 n，同一条命令重复三轮结果一致）：
  #     n = 1 / 2 / 3 / 5 / 10 / 20 / 40 / 60 / 80 / 100 / 120  → 命中（红，正确）
  #     n = 150 / 200 / 2000 / 20000                            → ★被吞（绿，错误）
  #   —— 分界在管道缓冲区（约 64 KB）那一格。
  #
  # **诚实边界**：真包里不会有 150 条 not found，所以这条在实际输入上**不会**发生；
  # 我没有把它说成"已经在害人"。留着这条用例的理由是另一个：同一族的
  # `ldd --version | head -1` **确实在本机复现了**（rc=141，同一条自检两次跑出不同结果），
  # 而那条是必然会执行的。一个判据一旦时灵时不灵，它说对的时候也不该被相信 ——
  # 所以两处一起改成"先取回文本再匹配"，一条管道都不留。
  lddbad="${d}/ldd-bad"
  make_stub_ldd "${lddbad}" 'echo "	libggml-base.so.0 => not found"; for i in $(seq 1 200); do echo "	libfiller$i.so => not found"; done'
  out="$(PATH="${lddbad}:${PATH}" bash "${SMOKE}" --archive "${arch}" \
        --pack-id whispercpp-vulkan-linux-x64 --backend vulkan --workdir "${d}/w3" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -ne 0 && "${out}" == *"libggml-*"* ]]; then ok "★反向：libggml-base.so.0 => not found → 红"
  else bad "libggml not found 应当红" "rc=${rc} out=${out}"; fi

  # ★边界：**不相干的**库 not found 必须**绿**。
  # `libcuda.so.1 => not found` 是一条完全正确的腿的正常输出（NVIDIA 驱动本来就不许随包分发）。
  # 一条会对不相干的东西发表意见的检查，说对的时候也不该被相信 —— 所以这条断言钉的是
  # 「收窄」本身，防的是有人把它"顺手放宽"成对任何 not found 都报红。
  lddok="${d}/ldd-cuda"; make_stub_ldd "${lddok}" 'echo "	libcuda.so.1 => not found"'
  out="$(PATH="${lddok}:${PATH}" bash "${SMOKE}" --archive "${arch}" \
        --pack-id whispercpp-vulkan-linux-x64 --backend vulkan --workdir "${d}/w4" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -eq 0 ]]; then ok "★边界：libcuda.so.1 => not found → 绿（断言只收窄到 libggml-*）"
  else bad "不相干的 not found 不该判红" "rc=${rc} out=${out}"; fi

  # cpu 腿不找加速模块
  archc="$(make_fake_pack "${d}/cpu" whispercpp-cpu-linux-x64 cpu no)"
  mkdir -p "${d}/cpu"
  out="$(bash "${SMOKE}" --archive "${archc}" --pack-id whispercpp-cpu-linux-x64 \
        --backend cpu --workdir "${d}/w5" 2>&1)" && rc=0 || rc=$?
  if [[ ${rc} -eq 0 ]]; then ok "cpu 腿不要求 libggml-cpu.so → 绿"
  else bad "cpu 正向应当绿" "rc=${rc} out=${out}"; fi
}

printf '\n'
if [[ ${fail} -gt 0 ]]; then
  printf '\033[31m✘ selftest-buildbox: %d passed, %d failed\033[0m\n' "${pass}" "${fail}"
  exit 1
fi
printf '\033[32m✔ selftest-buildbox: %d passed, 0 failed\033[0m\n' "${pass}"
