import { WEBSEARCH_CONFIG_PATH } from '../config/load.ts'
import { readWebsearchConfig, websearchEndpoint, type WebsearchConfig } from '../tools/websearch.ts'
import type { RouteResolver } from './credential-proxy.ts'

/** websearch 路由路径。websearch-bin 写死同一字面量 */
export const WEBSEARCH_ROUTE = '/websearch'

/**
 * `POST /websearch` → websearch.json 定的 Exa 端点（websearchEndpoint 同一套
 * 规则：官方端点 key 拼进 URL，自定义 url 走 Bearer，缺文件 = 匿名层）。
 * key 只在宿主进程里展开，bin 拿不到——websearch.json 写 `${EXA_API_KEY}`，
 * 模型 cat 到的只是变量名。配置错（变量没进宿主、JSON 坏）抛 → 代理回 500。
 */
export function websearchRoutes(load: () => Promise<WebsearchConfig>): RouteResolver {
  return async (path, method) => {
    if (path !== WEBSEARCH_ROUTE || method !== 'POST') return undefined
    return websearchEndpoint(await load())
  }
}

/** 每次请求现读（改了 websearch.json 不用 reload），宿主进程 env 展开 */
export const loadWebsearchConfig = (): Promise<WebsearchConfig> => readWebsearchConfig(WEBSEARCH_CONFIG_PATH)
