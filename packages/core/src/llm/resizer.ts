/**
 * 发送前的图片统一缩放（D3，web-tools.md §2）。
 *
 * **只动发出的一份**——调用方（run.ts 的每次 attempt）把 resize 结果直接
 * 发出去，不落库不回写 ctx。库里和内存里始终是原图，每轮从库重新组装再压
 * 一遍，天然幂等。跟摘要是同一模式：变换发生在出口，源头不动。
 *
 * 为什么在发送侧压而不是入口压：入口压了原图就没了，用户想回头看原图
 * （webview）只能拿到压过的；发送侧压，库里有完整原图，压坏的也只是这
 * 一次请求，下轮重压。
 *
 * 尺寸线：长边 2048、JPEG q85——这是
 * Anthropic/OpenAI vision 的内部 tile 上界，再大是浪费。字节线 5MB
 * （base64 编码后）是 Anthropic 的强制线。
 * 两条都在限内的图**原样放行不重编码**：重编码有损，白扔质量。
 *
 * 失败降级的总原则：**请求永不因图炸**。
 * - 解码失败（垃圾 base64 / 非 image 数据）→ 占位 TextPart
 * - 压不到 5MB 以内 → 占位 TextPart
 * - photon/wasm 本身加载失败 → 标志位记一次，之后所有图**原样放行**
 *   （ResizerUnavailableError → 原样）。图可能超限被 API 拒，
 *   那是看得见的错误，可修；静默吞图是不可见的错。
 */
import { createHash } from 'node:crypto'
import type { Capabilities, ImagePart, Message, Part } from './types'

/** 长边上限（像素），Anthropic vision 的 max_dimension */
const MAX_EDGE = 2048
/** base64 字符的字节长度上限。Anthropic 图片 5MB 线 */
const MAX_BASE64_BYTES = 5 * 1024 * 1024
/** 压缩档 */
const JPEG_QUALITIES = [85, 70, 55, 40]

/** 占位符。模型看到的是这个文本，不是空消息 */
const omitted = (reason: string) => `[image omitted: ${reason}]`

/**
 * photon 的类型是 wasm-bindgen 生成的，体积大且没有类型声明价值——
 * 这里只声明我们用到的那几个成员。
 */
export type Photon = {
  PhotonImage: {
    new_from_byteslice(bytes: Uint8Array): PhotonImage
  }
  resize(img: PhotonImage, width: number, height: number, filter: number): PhotonImage
  SamplingFilter: { Lanczos3: number }
}
export type PhotonImage = {
  get_width(): number
  get_height(): number
  get_bytes_jpeg(quality: number): Uint8Array
  free(): void
}

/**
 * 惰性加载 + 失败记忆。wasm 加载是一次性事件：能加载就一直能，不能加载
 * 重试也没用（文件缺失/架构不符）。Promise 缓存成功结果；失败也缓存——
 * 存 undefined 标记「不可用」，之后所有图原样放行，不再重试。
 */
let photonPromise: Promise<Photon | undefined> | undefined
function loadPhoton(): Promise<Photon | undefined> {
  photonPromise ??= import('@silvia-odwyer/photon-node')
    .then((m) => m as unknown as Photon)
    .catch((error) => {
      console.warn('[resizer] photon 加载失败，图片将原样发送:', error)
      return undefined
    })
  return photonPromise
}

/** 等比缩到长边 ≤ maxEdge，返回 [w, h]；已在限内返回原尺寸 */
function fitEdges(width: number, height: number, maxEdge: number): [number, number] {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

/** 压一张图。返回新的 ImagePart（重编码为 JPEG）或占位文本 */
async function shrinkPart(part: ImagePart, photon: Photon): Promise<Part> {
  let decoded: PhotonImage | undefined
  try {
    const bytes = Buffer.from(part.data, 'base64')
    decoded = photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes))
  } catch {
    return { type: 'text', text: omitted('could not decode image') }
  }
  try {
    const width = decoded.get_width()
    const height = decoded.get_height()
    // 两条线都在限内：原样。不重编码（无损优先）
    if (
      width <= MAX_EDGE &&
      height <= MAX_EDGE &&
      Buffer.byteLength(part.data, 'utf-8') <= MAX_BASE64_BYTES
    ) {
      return part
    }
    // 压缩循环：先把长边压进 2048，再按质量档降；仍超字节线就整体缩 0.75
    // 再来一轮
    let [w, h] = fitEdges(width, height, MAX_EDGE)
    for (let round = 0; round < 8; round++) {
      let resized: PhotonImage | undefined
      try {
        resized = photon.resize(decoded, w, h, photon.SamplingFilter.Lanczos3)
        for (const quality of JPEG_QUALITIES) {
          const data = Buffer.from(resized.get_bytes_jpeg(quality)).toString('base64')
          if (Buffer.byteLength(data, 'utf-8') <= MAX_BASE64_BYTES) {
            return { ...part, data, mimeType: 'image/jpeg' }
          }
        }
      } catch {
        return { type: 'text', text: omitted('resize failed') }
      } finally {
        resized?.free()
      }
      // 都超：缩 25% 重试
      ;[w, h] = fitEdges(w, h, Math.max(1, Math.floor(Math.max(w, h) * 0.75)))
    }
    return { type: 'text', text: omitted('could not compress below 5MB') }
  } finally {
    decoded.free()
  }
}

/**
 * 模型不支持图片时，把图片换成占位文本（原 normalize 的 pass 3，2026-09-07
 * 挪来）。不能直接删——删掉后上下文里会出现「看这张图」却没有图的断裂；
 * 占位文本让模型知道这里原本有个东西。
 *
 * **必须只动发出去的那份**（assembleForRequest 出口，resizeImageParts 之前）。
 * 原来在 normalize 里做，而 normalize 的产物会落库——图被换成占位文本后
 * persist() 把它存回 store，原图永久丢失，切回支持图的模型也救不回来。
 * 库里保留原图、每次组装现换，换模型就自动恢复
 *
 * captions 是 visionRelay 的转述缓存（run.ts 的 relayPendingImages 在发送
 * 前填好）：图 data → 转述文本。有转述的图换成转述（用户贴图与 view_image
 * 同口径——非视觉模型下不至于「看这张图」配一句干巴巴的占位符）；缓存没
 * 命中（没配 visionModel / relay 失败存 ''）才落到占位符
 */
export function stripImagesWhenUnsupported(
  messages: Message[],
  caps: Capabilities,
  captions?: ReadonlyMap<string, string>,
): Message[] {
  if (caps.images) return messages
  return messages.map((msg) => {
    // **没图的消息必须原引用返回**（对齐 resizeImageParts 的先例）：出口
    // 全量 `{...msg}` 新建会把消息引用全部换掉，regions 记账的保底区
    // （floor 集合按对象引用圈人）整区 miss，面板上 floor 恒 0、全部
    // 堆进「未卸载」——2026-09-12 实测就是这么错的
    if (!msg.parts.some((part) => part.type === 'image' || (part.type === 'tool_result' && part.images && part.images.length > 0))) {
      return msg
    }
    return {
      ...msg,
      parts: msg.parts.map((part) => {
      if (part.type === 'image') {
        const caption = captions?.get(part.data)
        return { type: 'text', text: caption || PLACEHOLDER } as Part
      }
      // tool_result 的图（webfetch/view_image）是字段不是 part，没有「占位
      // part」的形状——占位文本 append 到 output 尾部，每张一行（洞①，
      // 2026-09-08：不处理的话图原样进请求，非视觉模型 400 且每轮都 400）
      if (part.type === 'tool_result' && part.images && part.images.length > 0) {
        const { images: _removed, ...rest } = part
        const notes = part.images.map(() => PLACEHOLDER).join('\n')
        return { ...rest, output: `${part.output}\n${notes}` } as Part
      }
      return part
      }),
    }
  })
}

const PLACEHOLDER = '[图片已省略：当前模型不支持图片输入]'

/**
 * 压 tool_result 附带的图（webfetch 抓图 / view_image 读图，34efd42 加的
 * images 字段）。独立 image part 之外的第二条携带通道——当初漏了它：
 * webfetch 注释说「发送侧 resizer 统一处理」，但这里的循环只认
 * `type === 'image'`，tool_result 的图**从不压缩**原样直发，视觉模型下
 * 大图也会被 API 拒（洞②，2026-09-08 修）。
 *
 * 压不动（解码失败/压不进线）的图换成文本注脚 append 到 output——
 * tool_result 的图没有「占位 part」的形状（images 是字段不是 part），
 * 注脚是唯一能落到 wire 上的位置
 */
async function shrinkToolImages(
  part: Extract<Part, { type: 'tool_result' }>,
  photon: Photon,
): Promise<Part> {
  if (!part.images || part.images.length === 0) return part
  const kept: ImagePart[] = []
  const notes: string[] = []
  let changed = false
  // part.images 是 ImagePart[]（自带 type），不是入口侧的 ImageInput
  for (const img of part.images) {
    const result = await shrinkPart(img, photon)
    if (result.type === 'image') {
      changed = changed || result.data !== img.data
      kept.push(result)
    } else {
      changed = true
      // shrinkPart 的占位形态只有 text 一种；窄化给 TS 看
      if (result.type === 'text') notes.push(result.text)
    }
  }
  if (!changed) return part
  const { images: _removed, ...rest } = part
  const output = notes.length > 0 ? `${part.output}\n${notes.join('\n')}` : part.output
  // exactOptionalPropertyTypes：images 没了就不带字段，不能赋 undefined
  return { ...rest, output, ...(kept.length > 0 ? { images: kept } : {}) }
}

/** 入口：遍历消息，替换所有 ImagePart。其余 part/消息结构原样 */
export async function resizeImageParts(messages: Message[]): Promise<Message[]> {
  // 先扫有没有图，没有直接返回——不碰 photon。加载失败会打一次警告
  // （失败记忆），纯文本轮不该见到 [resizer] 字样
  const hasImage = messages.some(
    (m) =>
      m.parts.some((p) => p.type === 'image') ||
      m.parts.some((p) => p.type === 'tool_result' && p.images && p.images.length > 0),
  )
  if (!hasImage) return messages
  const photon = await loadPhoton()
  if (!photon) return messages
  const next: Message[] = []
  for (const message of messages) {
    let changed = false
    const parts: Part[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result' && part.images && part.images.length > 0) {
        const result = await shrinkToolImages(part, photon)
        changed = changed || result !== part
        parts.push(result)
        continue
      }
      if (part.type !== 'image') {
        parts.push(part)
        continue
      }
      const result = await shrinkPart(part, photon)
      changed = changed || result !== part
      parts.push(result)
    }
    next.push(changed ? { ...message, parts } : message)
  }
  return next
}

/** 缩略图边长（px）。webview 列表行内显示用 */
const THUMB_EDGE = 256

/**
 * 缩略图缓存：原图 sha1 → data URL。切目录会关 session、切回重建基线，
 * 同一批图每次都要 photon 同步重算（某真库 12 张 879ms，卡宿主）。
 * 进程级、按原图内容作键：基线/分页/live 三条路径共用，session 关了也
 * 还在。上限 300 条（256px JPEG 每张十几 KB，≈ 几 MB），满了丢最久没用的
 */
const THUMB_CACHE_MAX = 300
const thumbCache = new Map<string, string>()

/**
 * 出 256px JPEG data URL 给 webview 做行内缩略图。原图几 MB 直接塞
 * 事件流会把 webview 撑爆（web-tools §8 阶段 3）。
 *
 * 失败返回 undefined——缩略图是装饰，不是数据，缺了只是那行没图。
 * 复用同一个 photonPromise：wasm 不可用时缩略图也没有，行为一致
 */
export async function thumbnailDataUrl(part: ImagePart): Promise<string | undefined> {
  const key = createHash('sha1').update(part.data).digest('base64')
  const hit = thumbCache.get(key)
  if (hit !== undefined) {
    // 重插到末尾 = 最近用过（Map 按插入序迭代，头部是最久没用的）
    thumbCache.delete(key)
    thumbCache.set(key, hit)
    return hit
  }
  const url = await makeThumbnail(part)
  // 失败不缓存：wasm 加载失败这类可能是暂时的，下次再试
  if (url !== undefined) {
    thumbCache.set(key, url)
    if (thumbCache.size > THUMB_CACHE_MAX) {
      const oldest = thumbCache.keys().next().value
      if (oldest !== undefined) thumbCache.delete(oldest)
    }
  }
  return url
}

async function makeThumbnail(part: ImagePart): Promise<string | undefined> {
  const photon = await loadPhoton()
  if (!photon) return undefined
  let decoded: PhotonImage | undefined
  try {
    decoded = photon.PhotonImage.new_from_byteslice(
      new Uint8Array(Buffer.from(part.data, 'base64')),
    )
  } catch {
    return undefined
  }
  try {
    const [w, h] = fitEdges(decoded.get_width(), decoded.get_height(), THUMB_EDGE)
    let resized: PhotonImage | undefined
    try {
      resized = photon.resize(decoded, w, h, photon.SamplingFilter.Lanczos3)
      const data = Buffer.from(resized.get_bytes_jpeg(85)).toString('base64')
      return `data:image/jpeg;base64,${data}`
    } finally {
      resized?.free()
    }
  } finally {
    decoded.free()
  }
}
