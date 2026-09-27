/**
 * Remote-SSH 走本机网络（方案 C + 伴生扩展，2026-09-25 拍板）的共用常量。
 *
 * 这个端口出现在四处：主扩展 remote.ts 的同步与指引卡、伴生扩展（companion）
 * 的代理监听口、ssh config 的 RemoteForward 行、（老用户）launchd 版代理的
 * llm-proxy.json。错一处整条链路静默断——所以放 core 一份，两个扩展包都从
 * 这里拿。
 */
export const LLM_PROXY_PORT = 15432

/** ssh config 的转发行。companion 的自动追加与主扩展指引卡的「复制配置块」
 * 共用这一份——两处各写一份必漂移（2026-09-25 实测：卡片只复制了裸行，
 * 按主机直连、没有现成 Host 块的用户粘了不能用甚至粘错位） */
export const forwardLine = (): string =>
  `RemoteForward ${LLM_PROXY_PORT} 127.0.0.1:${LLM_PROXY_PORT}`

/** 追加到 ~/.ssh/config 末尾的完整块——Host 块头 + 转发行。裸转发行放
 * 文件顶部会给所有主机开转发，放进不匹配的块里则不生效，所以要块 */
export const forwardBlock = (host: string): string =>
  `# added by SimpleCode — local LLM proxy tunnel\nHost ${host}\n  ${forwardLine()}\n`
