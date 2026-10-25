import { homedir } from 'node:os'
import { loadConfig, resolveImageModel, type ImageModel } from '../config/load.ts'
import type { RouteResolver } from './credential-proxy.ts'

/** 生图路由路径。bin 侧 imagegen-bin.ts 写死同一字面量（不 import 本文件，免得把 loadConfig 打进 bin） */
export const IMAGE_ROUTE = '/image/generations'

/**
 * `POST /image/generations` → imageModel 所借 provider 的
 * `<baseUrl>/v1/images/generations`，注入 `Authorization: Bearer <apiKey>`，
 * 并把 `model` 钉成 imageModel.model——bin 只给 prompt/size/quality/n/
 * output_format，换不了模型也换不了上游（docs/proposals/imagegen.md）。
 * 未配置 imageModel 抛错 → 代理回 500，不发上游、不计费。
 */
export function imageRoutes(load: () => Promise<ImageModel | null>): RouteResolver {
  return async (path, method) => {
    if (path !== IMAGE_ROUTE || method !== 'POST') return undefined
    const image = await load()
    if (!image) throw new Error('未配置 imageModel——在 ~/.simple-code/settings.json 加 "imageModel": {"provider": "...", "model": "..."}')
    return {
      url: `${image.baseUrl.replace(/\/+$/, '')}/v1/images/generations`,
      headers: { authorization: `Bearer ${image.apiKey}` },
      body: { model: image.model },
    }
  }
}

/** 每次请求现读全局 settings.json（改了不用 reload）。宿主进程的 env 展开 apiKey */
export async function loadImageModel(): Promise<ImageModel | null> {
  // 传 home：工作区设置路径与全局重合，loadConfig 只读全局一份
  const loaded = await loadConfig(homedir())
  return resolveImageModel(loaded.config)
}

/** 依次问每个解析器，第一个认领的生效 */
export function firstRoute(...resolvers: RouteResolver[]): RouteResolver {
  return async (path, method) => {
    for (const resolve of resolvers) {
      const route = await resolve(path, method)
      if (route) return route
    }
    return undefined
  }
}
