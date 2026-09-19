/**
 * Explorer 拖文件 → 路径文本（2026-09-08 拍板：只支持 VS Code 资源管理器
 * 拖入；产物一律是路径——图片也不内联，模型用 view_image 按需看；项目内
 * 相对、项目外绝对。OS Finder 拖不支持，preventDefault 挡掉原生行为即可）。
 *
 * 宿主不兼容是难点：Explorer 拖**不给 File 对象**，只在私有类型里给埋着路径的 payload；
 * OS 拖才给 File。判据 = files 空 && types 命中私有类型。`text/uri-list` 和
 * `text/plain` 是通用类型（OS 拖也有），只能当解析源、不能当「是 Explorer」
 * 的证据——所以两者拆开判断。
 *
 * payload 格式随 VS Code 版本变（旧 CodeFiles JSON / 新 vnd.code.tree JSON /
 * 裸 URI），所以不精解析：三遍扫描（原文、逐行、JSON.parse 深挖字符串叶子），
 * 每层用「长得像绝对路径吗」过滤——格式怎么变都免疫。
 *
 * 全是纯函数 + 鸭子类型的 DropData，构造 fake 就能测。dragover 时 getData
 * 在部分宿主会 throw，所以判据只看 types，payload
 * 解析只在 drop 时做。
 */

/** DataTransfer 的最小形状。真 DataTransfer 天然兼容 */
export interface DropData {
  readonly files: { readonly length: number }
  readonly types: readonly string[]
  getData(type: string): string
}

const TREE_PREFIX = 'application/vnd.code.tree'
/** Explorer 私有类型（判据用）。tree 系按前缀匹配，覆盖 .explorer 等变体 */
/** Cursor 私有类型（2026-09-09 三轮实测：drop 的 types 只有这三个，
 * VS Code 的 codefiles/text/plain 一个都不给；resourceurls 是 file:///
 * JSON 数组、codeeditors 是编辑器 tab 拖的 JSON 对象、uri-list 是裸 URI 行） */
const CURSOR_TYPES = ['resourceurls', 'codeeditors', 'application/vnd.code.uri-list']
/** Explorer 私有类型（判据用）。tree 系按前缀匹配，覆盖 .explorer 等变体 */
const EXPLORER_TYPES = ['codefiles', 'CodeFiles', ...CURSOR_TYPES]
/** payload 解析源：私有类型 + 通用类型（只能当来源，见文件头） */
const PAYLOAD_TYPES = [...EXPLORER_TYPES, TREE_PREFIX, 'text/uri-list', 'text/plain']

export function isExplorerDrag(dt: DropData | null): boolean {
  if (!dt) return false
  if (dt.files?.length > 0) return false
  return dt.types.some((t) => t.startsWith(TREE_PREFIX) || EXPLORER_TYPES.includes(t))
}

/** OS Finder/浏览器拖（有真 File 对象）。不支持，但调用方要认出来做 notice */
export function hasOsFileDrag(dt: DropData | null): boolean {
  return dt !== null && dt.files?.length > 0
}

export function parseExplorerPaths(dt: DropData | null): string[] {
  if (!dt) return []
  const found = new Set<string>()
  for (const type of PAYLOAD_TYPES) {
    const payload = readData(dt, type)
    if (payload) collectCandidates(payload, found)
  }
  return [...found]
}

/** 单值 → 路径或 null：trim、去引号、多行拒绝、只认 file:// 或绝对形态 */
function looksLikePath(value: string): string | null {
  const trimmed = value.trim().replace(/^["']+|["']+$/g, '')
  if (trimmed === '' || /[\r\n]/.test(trimmed)) return null
  if (trimmed.toLowerCase().startsWith('file://')) return fileUriToPath(trimmed)
  const isAbsolute =
    trimmed.startsWith('/') || trimmed.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(trimmed)
  return isAbsolute ? trimmed : null
}

/** file:///a/b%20c → /a/b c。decodeURIComponent 会炸的（畸形 %）原样返回 */
function fileUriToPath(uri: string): string {
  const rest = uri.slice('file://'.length)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

function readData(dt: DropData, type: string): string {
  try {
    return dt.getData(type)
  } catch {
    return ''
  }
}

/** 三遍扫描：原文整段 → 逐行 → JSON 深挖。Set 去重（同一 payload 常在多个类型里重复） */
function collectCandidates(payload: string, out: Set<string>): void {
  addIfPath(payload, out)
  for (const line of payload.split(/\r?\n/)) addIfPath(line, out)
  try {
    collectLeaves(JSON.parse(payload), out, 0)
  } catch {
    // 不是 JSON——前两遍已覆盖
  }
}

function addIfPath(value: string, out: Set<string>): void {
  const path = looksLikePath(value)
  if (path !== null) out.add(path)
}

/** 深挖 JSON 里的字符串叶子。depth 挡构造出来的深嵌套 */
function collectLeaves(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 8 || value === null || typeof value !== 'object') return
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v === 'string') addIfPath(v, out)
    else collectLeaves(v, out, depth + 1)
  }
}

/** 项目内 → 相对路径；项目外 → 绝对；正好是根 → '.'。两边都归一成 /（Windows 兜底） */
export function toDisplayPath(abs: string, root: string): string {
  const p = abs.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (r === '') return p
  if (p === r) return '.'
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p
}

/**
 * 发送时附件展开进消息文本（2026-09-12 方案 A：输入框里是气泡，发出去仍是
 * 纯路径行——agent 收到的格式与旧版手打路径完全一致，渲染侧 PathText 链接化）。
 * 路径在前、空行隔开、正文在后；只有附件时（无正文）不产生尾随空行。
 */
export function composeWithAttachments(text: string, attached: readonly string[]): string {
  if (attached.length === 0) return text
  const head = attached.join('\n')
  return text === '' ? head : `${head}\n\n${text}`
}
