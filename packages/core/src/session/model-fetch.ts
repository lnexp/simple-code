import type { LoadedConfig } from '../config/load.ts'
import { claudeSdkFetch } from '../llm/claude-sdk-fetch.ts'
import { sdkError } from '../llm/claude-sdk-runtime.ts'

type Scope = { folder: string; remote?: boolean; fetchImpl?: typeof fetch }

export function modelFetch(config: LoadedConfig, scope: Scope): typeof fetch | undefined {
  if (!config.model.claudeAgentSdk) return scope.fetchImpl
  if (process.platform !== 'darwin') throw sdkError('首版仅支持 macOS')
  if (scope.remote || process.env.SSH_CONNECTION) throw sdkError('首版不支持 Remote-SSH')
  return claudeSdkFetch({
    path: config.config.claudeAgentSdkPath!,
    folder: scope.folder,
    ...(scope.fetchImpl ? { fetchImpl: scope.fetchImpl } : {}),
  })
}
