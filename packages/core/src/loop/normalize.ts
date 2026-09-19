import type { Message, Part, ToolCallPart, ToolResultPart } from '../llm/types.ts'

/**
 * 两个 pass，顺序固定。每一个防的都是「不报错但整条对话卡死」的情况：
 *
 * 1. 有 tool_call 没有 tool_result → 400，而且这条历史一直在，之后每轮都 400
 * 2. 有 tool_result 没有对应的 tool_call → 同上
 *
 * 原来还有 pass 3「模型不支持图片时把图换成占位文本」——**挪走了**（2026-09-07）。
 * 这两个 pass 落库是合理的（结构修复，补/删的是本来就该有的东西），但 pass 3
 * 是能力降级：normalize 的产物会被 persist() 存回 store，图换成占位文本后
 * **原图从库里被烧掉**，切回支持图的模型也救不回来——违反「历史可以降
 * 分辨率不能丢」（AGENTS.md 产品边界）。实测受害：换 vision 模型之前发的图
 * 全部变成占位文本。现在它在 assembleForRequest 出口做（resizer.ts 的
 * stripImagesWhenUnsupported），只动发出去的那份，与 resizeImageParts 同款。
 *
 * 两个 pass 实际可交换（变异检验确认过）——ensureCallOutputsPresent 补出来
 * 的 result 按构造一定有配对的 call，removeOrphanOutputs 不可能删到它。
 */
export function normalizeHistory(messages: Message[]): Message[] {
  return normalizeWithOrigin(messages).messages
}

/**
 * 同 `normalizeHistory`，另外报告**每条输出消息来自输入的哪个下标**。
 *
 * ## 为什么需要它
 *
 * 三个 pass 会增删条数（pass 1 插占位、`dropParts` 丢掉变空的消息），而
 * `store` 的 `turnOf` / `stepOf` 是**按下标**对齐消息数组的。一次中断补
 * tool_result，插入点之后的全部历史就整体错一位——**不报错**，只是某轮
 * 历史归错 turn，等到摘要按 turn 分组时才炸（提案 §1.5 补记）。
 *
 * `origin[i] = null` 表示这条是新插进来的。调用方（store）让它**继承前一条**
 * 的归属：补出来的 tool_result 天然属于它要回答的那个 tool_call 那一轮。
 *
 * ## 为什么三个 pass 改成在 `{ msg, origin }` 上跑
 *
 * 试过更省事的写法：给 message 挂一个隐藏字段，靠每个 pass 都用 `{...msg}`
 * 把它带过去。**不能这么写**——它依赖一个不成文的约定，将来有人写个从头
 * 构造消息的 pass，归属就会静默出错（CLAUDE.md §6.4 那一类）。显式带着走
 * 的话，新 pass 不处理 origin 是编译错误。
 */
export function normalizeWithOrigin(
  messages: Message[],
): { messages: Message[]; origin: (number | null)[] } {
  const tagged = removeOrphanOutputs(
    ensureCallOutputsPresent(messages.map((msg, origin) => ({ msg, origin }))),
  )
  return { messages: tagged.map((t) => t.msg), origin: tagged.map((t) => t.origin) }
}

/** 一条消息 + 它在**归一化前**的下标。null = 这一趟新插进来的 */
type Tagged = { msg: Message; origin: number | null }

/** 用户中断时补的占位。不同于工具正常失败——它不算"待处理工作"（core-modules.md §7） */
export const interruptedResult = (call: ToolCallPart): ToolResultPart => ({
  type: 'tool_result',
  toolCallId: call.id,
  output: '这次工具调用被用户中断，没有执行。',
  isError: true,
  interrupted: true,
})

/**
 * pass 1：每个 tool_call 都必须有配对的 tool_result。
 *
 * 缺配对的原因通常是中断或崩溃。补一条标注 interrupted 的占位，而不是把
 * tool_call 删掉——删掉会让 assistant 消息与模型的实际输出不符，reasoning
 * 的 signature 校验也可能因此失败。
 */
function ensureCallOutputsPresent(items: Tagged[]): Tagged[] {
  const answered = new Set(
    items
      .flatMap((t) => t.msg.parts)
      .flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : [])),
  )

  const out: Tagged[] = []
  let mergedInto = -1

  for (const [index, item] of items.entries()) {
    if (index === mergedInto) continue // 已经作为占位的落脚点被处理过

    const missing = item.msg.parts.filter(
      (p): p is ToolCallPart => p.type === 'tool_call' && !answered.has(p.id),
    )
    if (missing.length === 0) {
      out.push(item)
      continue
    }
    for (const call of missing) answered.add(call.id)

    const placeholders = missing.map(interruptedResult)
    const next = items[index + 1]
    if (next?.msg.role === 'tool') {
      // 并进下一条 tool 消息而不是新插一条：同一条 assistant 发了两个
      // tool_call、只有一个拿到结果时，新插会得到两条连续的 tool 消息。
      // 占位排在真实结果之后。**并进去的那条 origin 不变**——它本来就在
      // 输入里，只是多了几个 part
      out.push(item, {
        msg: { ...next.msg, parts: [...next.msg.parts, ...placeholders] },
        origin: next.origin,
      })
      mergedInto = index + 1
    } else {
      out.push(item, { msg: { role: 'tool', parts: placeholders }, origin: null })
    }
  }
  return out
}

/** pass 2：删掉没有对应 tool_call 的 tool_result。孤儿 result 同样是 400 */
function removeOrphanOutputs(items: Tagged[]): Tagged[] {
  const called = new Set(
    items.flatMap((t) => t.msg.parts).flatMap((p) => (p.type === 'tool_call' ? [p.id] : [])),
  )
  return dropParts(items, (p) => p.type === 'tool_result' && !called.has(p.toolCallId))
}

/** 删除匹配的 part，并丢掉因此变空的消息——空 parts 的消息本身也可能 400 */
function dropParts(items: Tagged[], shouldDrop: (part: Part) => boolean): Tagged[] {
  return items
    .map((t) => ({ ...t, msg: { ...t.msg, parts: t.msg.parts.filter((p) => !shouldDrop(p)) } }))
    .filter((t) => t.msg.parts.length > 0)
}

/**
 * 还有没有待执行的工具调用。
 *
 * **判据是「有没有结果」，不是「结果是不是成功」**。被中断的调用有一条标注
 * interrupted 的占位结果，所以这里算它「不待处理」——这些是 cleanup 标记的废弃调用，不是待办工作。
 * 算进去的话 loop 会空转一轮：发个请求过去，模型看到一堆已完成的东西，
 * 无事可做，再返回。
 *
 * 所以必须在 normalizeHistory 之后调用——那时占位已经补齐。
 */
export function hasPendingToolCalls(messages: Message[]): boolean {
  const answered = new Set(
    messages
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : [])),
  )
  return messages
    .flatMap((m) => m.parts)
    .some((part) => part.type === 'tool_call' && !answered.has(part.id))
}

/**
 * 有没有还没回应的用户输入——退出条件的第四个合取项（core-modules.md §7）。
 *
 * 用户在 agent 跑的时候插一句话，没有这个判断的话 loop 会认定「没有 tool
 * call 了，结束」，**那条消息直接被丢掉，不报错**。
 *
 * 判据是 role === 'user'，一个字段就够。tool_result 是独立的 tool 消息，
 * 不会混进来——这正是 canonical 保留 tool 角色换来的（llm/types.ts）。
 * 挂在 user 消息里的话这里得改成「parts 里有没有非 tool_result 成分」，
 * 而且中断时补的占位会被当成用户插话，loop 空转一轮。
 */
export function hasUnansweredUserInput(messages: Message[]): boolean {
  const lastUser = messages.findLastIndex((m) => m.role === 'user')
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant')
  return lastUser > lastAssistant
}
