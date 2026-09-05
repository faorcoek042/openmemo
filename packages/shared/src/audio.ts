/**
 * 音频链路上**跨进程必须一致**的那几个数。
 *
 * ## 为什么这个数必须只有一份
 *
 * 它原来有**四份**，分别写在：
 *
 * | 位置 | 名字 | 角色 |
 * |---|---|---|
 * | `apps/web/src/features/recorder/asrStream.ts` | `RECORD_SAMPLE_RATE` | 浏览器 `AudioContext` 的采集率 |
 * | `apps/daemon/src/ws/recorder.ts` | `RECORD_SAMPLE_RATE` | WS 上行 PCM 的约定 + 写进 WAV 头 |
 * | `packages/pipeline/src/audio/ffmpeg.ts` | `ASR_SAMPLE_RATE` | 离线转写时 ffmpeg 的重采样目标 |
 * | `packages/pipeline/src/asr/sherpaOnnx.ts` | `SHERPA_SAMPLE_RATE` | 喂给 sherpa 识别器的 `sampleRate` |
 *
 * ⚠️ **四个名字不同，所以「重名」这条判据对它是盲的**（`check-duplicate-declarations.mjs`
 * 只有裸数值那一档看得见它，而那一档实测误报太高、不判红）。
 *
 * 而它是一条**跨进程协议常量**：浏览器按这个率采集 → 原样二进制上行 → daemon 按这个率
 * 写 WAV 头并转发给 `AsrStream.write()` → 识别器被告知这就是它拿到的率。
 * **中间没有任何一次重采样。** 于是任何一处改了、别处没改：
 *
 *   · 不会有编译错误（都是 `number`）；
 *   · 不会有测试红（每一份都有自己的断言，各自都自洽）；
 *   · 症状是**识别结果整体错位 / 音高变调**，而 WAV 头里那个数还言之凿凿。
 *
 * 这正是本仓反复吃亏的形状：同一件事几处各写一遍，第一次一致，第三次就不一致了，
 * 而且**没有任何东西会报错**。
 *
 * ## 判它们是同一个东西的依据（不是"看起来都是 16000"）
 *
 * `apps/daemon/src/ws/recorder.ts` 自己写着「与 `AsrStream.write()` 的契约一致」——
 * 也就是说录音率**在定义上**就是识别器的输入率；而 `ffmpeg.ts` 写着「whisper.cpp 与
 * sherpa-onnx 都要 16 kHz 单声道 PCM」，那是同一个识别器输入率的另一条到达路径（离线文件）。
 * 四处说的是**同一个事实**：*我们的 ASR 消费的 PCM 采样率*。
 *
 * ⚠️ 反过来说：将来真出现「某个引擎要 8 kHz」的正当分叉，改法**不是**把这里再抄一份，
 * 是让那个引擎的适配器显式声明自己的率，并在喂它之前真的重采样。
 * 分叉必须是**看得见的一行**，不是四份各自漂移。
 */

/**
 * 我们的 ASR 全链路消费的 PCM 采样率（Hz）。单声道 int16 小端。
 *
 * 消费者：web 录音采集、daemon 录音 WS + WAV 头、ffmpeg 重采样目标、sherpa 识别器配置。
 */
export const ASR_SAMPLE_RATE = 16_000;

/** ASR 输入声道数。立体声进识别器只会让它多算一倍还更差。 */
export const ASR_CHANNELS = 1;
