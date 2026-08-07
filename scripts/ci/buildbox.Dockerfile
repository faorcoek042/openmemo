# ══════════════════════════════════════════════════════════════════════════════════════
#  buildbox —— Linux 产物的**编译环境**，与 GitHub runner 的镜像版本解耦
# ══════════════════════════════════════════════════════════════════════════════════════
#
#  ## 它解决的是哪一件事（T-163）
#
#  两条要求同时成立，而在 T-161 之前它们是互相矛盾的：
#
#    A. **runner 必须升到 `ubuntu-24.04`** —— `ubuntu-22.04` 的 runner 镜像
#       2026-09-17 起进入 deprecation、2027-04-17 完全不支持
#       （actions/runner-images#14254，Ubuntu2404-Readme.md 顶部的公告栏原文）。
#       期间有 brownout，job 会**硬失败**。
#    B. **产物的 glibc 下限必须 ≤ 2.34** —— 24.04 上直接编出来的
#       `libggml-vulkan.so` 需要 GLIBC_2.38（三个 `__isoc23_strtol` 家族符号），
#       在 Ubuntu 22.04(2.35) / Debian 12(2.36) 上 `dlopen` **静默失败**：
#       `GGML_BACKEND_DL` 下失败不是错误，只是"后端没注册上"，
#       whisper 照常用 CPU 跑完（D-11 §8.2）。
#
#  T-161 的解法是把 runner 挪回 22.04 —— 那满足 B，但撞上 A。
#  `[实测，T-161]` 留在 24.04 上"压住 C23 重定向"这条路是**堵死的**：
#  触发源是 g++ driver 无条件注入的 `-D_GNU_SOURCE`（gcc/config/gnu-user.h 的
#  `CPLUSPLUS_CPP_SPEC`，gcc-12 与 gcc-13 两个分支字节相同），不是语言标准版本 ——
#  C++ 侧 `-std=c++11/17/20/23` 逐个试过全部仍然产出 `__isoc23_strtol`，换 gcc-12 也无效。
#
#  **所以真正要解耦的是「runner 标签」与「编译环境的 glibc」这两件事。**
#  它们本来就不该绑在一起：runner 标签的生命周期由 GitHub 决定（两年一换），
#  而 glibc 下限是**我们对用户机器的承诺**，不该跟着 GitHub 的排期漂。
#
#  ## 为什么是 docker 镜像而不是别的
#
#  `[实测]` `ubuntu:18.04` / `20.04` / `22.04` / `24.04` 四个 tag 今天在 Docker Hub
#  上全部 pull 得到（registry manifest HTTP 200）—— 而 `ubuntu-18.04` 这个 **runner 标签**
#  早就被删了好几年。也就是说：**镜像的寿命远长于 runner 标签的寿命**，
#  这正是我们要的那条性质。
#
#  排除掉的两条替代路线（都不是没想过）：
#    · `zig cc -target x86_64-linux-gnu.2.28` —— CUDA 腿结构上不成立（nvcc 要一个
#      它认识的宿主编译器），且 ggml 没有任何一条 CI 在 zig 上跑过。
#    · `polyfill-glibc` 之类的**产物后处理**工具 —— 它改的是我们要发给用户的二进制本身，
#      而 `__isoc23_strtol` → `strtol` 的语义差异（C23 的 `0b` 前缀）是真的存在的。
#      "编出来就是对的" 比 "编完再改对" 强一个量级。
#
#  ## ⚠️ 基线不靠这个文件维持
#
#  这个镜像**不是**那条 glibc 基线的守卫，它只是让基线容易满足。
#  真正的判据是 `scripts/ci/check-elf-glibc.mjs`：逐个 ELF 跑 `objdump -T`、
#  取最高 `GLIBC_x.y`、> 2.34 就红并点名符号。
#  换掉 BASE_IMAGE、绕过容器、甚至把这个文件删了 —— 只要产物超标，那一步就会红。
#  （D-11 §8.2：「一条靠"记得别动它"维持的基线，等价于一条迟早会被绕过的基线」。）
#
#  ## BASE_IMAGE 为什么用 tag 而不是 digest
#
#  本仓对"可变引用"一向敌视（ffmpeg 那条 `latest` tag、autobuild 日构建的 404）。
#  这里刻意用 `ubuntu:22.04` 这个会滚动的 tag，理由有二，都写下来供后人推翻：
#    ① 我们依赖的性质是「glibc 是 2.35」，它在 22.04 整个生命周期里是**固定的**，
#       滚动的只是安全更新；而这条性质有硬守卫兜底（见上）。
#    ② 钉 digest 会把编译工具链**冻在一个已知有漏洞的版本上**，
#       而收益是防一件已经被守卫防住的事。
#  （对照：ffmpeg 那条必须钉，因为那是**发给用户的二进制本身**，没有第二道验证。）

ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

# 只在 cuda 腿装 CUDA。cpu / vulkan 腿的镜像保持在 ~500 MB 量级。
ARG BACKEND=cpu
# 点分形式（`12.4`）。apt 包名用的是短横线形式，下面就地转换。
ARG CUDA_VERSION=12.4

ENV DEBIAN_FRONTEND=noninteractive

# `cmake` 在 jammy 是 3.22.1；ggml 要求 `cmake_minimum_required (VERSION 3.14...3.28)`，
# whisper.cpp 要求 3.5 —— 3.22 够用。`file` / `binutils` 是给烟雾测试里的
# `ldd` / `objdump` 用的（判据必须在**编译环境**里跑，见 buildbox.sh 的文件头）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      ccache \
      git \
      pkg-config \
      binutils \
      file \
      ca-certificates \
      curl \
      wget \
      xz-utils \
      unzip \
      zip \
 && rm -rf /var/lib/apt/lists/*

# --- CUDA ------------------------------------------------------------------------------
#
# ★ 为什么不再用 `Jimver/cuda-toolkit`（T-145 在它上面烧了三轮）：
#
#   那个 action 的 network 方法会 `lsb_release -sr` 出宿主发行版、拼出
#   `repos/ubuntu<XXXX>/` 的仓库地址。在容器里它会读到 22.04 → 仍然对；
#   但它同时要 `sudo` / `software-properties-common` / `lsb-release` 三个包，
#   而且它把包名拼成 `cuda-<项>-<major>-<minor>` —— T-145 §CUDA 记着两轮把
#   cuBLAS 的名字写错、每轮烧掉一次真跑。**在这里直接写死包名比让它去拼更短也更诚实。**
#
# `[实测 2026-08-07]` NVIDIA 的仓库索引：
#   `repos/ubuntu2204/x86_64/` 有 `cuda-nvcc-12-4_12.4.99` 与 `_12.4.131`
#   `repos/ubuntu2404/x86_64/` **最老只到 12-5** —— 这就是 T-145 第二轮
#   「Package 'cuda-nvcc-12-4' has no installation candidate」的成因，
#   也是"把 CUDA 腿挪到 24.04 宿主"这条路走不通的原因。
#   → 在 jammy 容器里装，仓库路径回到 ubuntu2204，12.4 又拿得到了。
#
# `cuda-keyring_1.1-1_all.deb` 是带版本号的固定文件名（HTTP 200 实测），
# 不是 `latest` 那类可变引用。
RUN set -eux; \
    if [ "${BACKEND}" = "cuda" ]; then \
      pkg="$(echo "${CUDA_VERSION}" | tr '.' '-')"; \
      wget -q -O /tmp/cuda-keyring.deb \
        "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb"; \
      dpkg -i /tmp/cuda-keyring.deb; \
      rm -f /tmp/cuda-keyring.deb; \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        "cuda-nvcc-${pkg}" \
        "cuda-cudart-${pkg}" \
        "cuda-cudart-dev-${pkg}" \
        "cuda-nvrtc-${pkg}" \
        "cuda-nvrtc-dev-${pkg}" \
        "libcublas-${pkg}" \
        "libcublas-dev-${pkg}"; \
      rm -rf /var/lib/apt/lists/*; \
      test -x "/usr/local/cuda-${CUDA_VERSION}/bin/nvcc"; \
    fi

# cpu / vulkan 腿上这个目录不存在 —— PATH 里多一个不存在的目录是无害的，
# 而"每条腿各设各的 PATH"要靠人记得。
ENV PATH=/usr/local/cuda-${CUDA_VERSION}/bin:${PATH}
