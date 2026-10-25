export type { LoadedConfig, LoadOptions, ModelRef } from './config/load.ts'
export { expandEnv } from './config/env.ts'
export { deepMerge } from './config/denylist.ts'
export { LLM_PROXY_PORT, forwardBlock, forwardLine } from './remote.ts'
export {
  GLOBAL_CONFIG_PATH,
  listModels,
  loadConfig,
  selectModel,
  WORKSPACE_CONFIG_RELATIVE,
} from './config/load.ts'
export type {
  BashConfigShape,
  Config,
  ModelSpec,
  ProviderSpec,
  RequestPreferences,
} from './config/schema.ts'
export { configSchema } from './config/schema.ts'
export type { AgentEvent } from './events.ts'
export type { SendOptions } from './llm/client.ts'
export { sendRequest } from './llm/client.ts'
export type { LLMEvent, Reducer, SSEMessage } from './llm/events.ts'
export type {
  ErrorKind,
  Protocol,
  ProtocolError,
  ProtocolName,
  ProviderContext,
} from './llm/protocol.ts'
export { LLMStreamError } from './llm/protocol.ts'
export { PROTOCOL_NAMES, resolveProtocol } from './llm/registry.ts'
export type {
  Capabilities,
  Effort,
  FinishReason,
  ImageInput,
  ImagePart,
  Message,
  Part,
  ReasoningPart,
  Request,
  TextPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
  Usage,
} from './llm/types.ts'
export { hasPendingToolCalls, interruptedResult, normalizeHistory } from './loop/normalize.ts'
export type { RetryConfig, StreamEvent } from './loop/retry.ts'
export { requestWithRetry } from './loop/retry.ts'
export type { ApprovalCategory, ApprovalVerdict } from './tools/approval.ts'
export type { BgProcessInfo } from './tools/bg.ts'
export type { LoopContext, LoopDeps, MemoryDeps, Task } from './loop/run.ts'
export { run } from './loop/run.ts'
export {
  estimateMessageTokens,
  estimateTokens,
  totalInputTokens,
  totalTokens,
} from './loop/tokens.ts'
export { unloadMessage } from './loop/unload.ts'
export type { SetTimer } from './session/idle.ts'
export { watchIdle } from './session/idle.ts'
export type { Lock } from './session/lock.ts'
export { acquireLock, LOCK_RELATIVE, LockHeldError } from './session/lock.ts'
export {
  TASK_TURN_GAP,
  flipTaskLive,
  finalizeTask,
  forkTask,
  listTaskManifests,
  readTaskManifest,
  scopeOf,
  type TaskManifest,
} from './session/task.ts'
export type { TaskScope } from './session/store.ts'
export { SegmentFullError } from './session/store.ts'
export { openStore } from './session/store.ts'
export type { CompactResult, Session, SessionOptions } from './session/session.ts'
export {
  getSession,
  MODEL_SWITCH_HEAD,
  modelSwitchNotice,
  toHydrateRows,
  type HydratePart,
  type HydrateRow,
} from './session/session.ts'
export type { Store } from './session/store.ts'
export { type HistoryRow, lastRegionLine, MEMORY_RELATIVE } from './session/store.ts'
export { openDbReadOnly } from './session/db.ts'
export type { BashConfig } from './tools/bash.ts'
export { createBashTool } from './tools/bash.ts'
export type { RawSink, Tool, ToolContext, ToolOutput } from './tools/types.ts'
export { createViewImageTool } from './tools/viewimage.ts'
export { applyPatch, parsePatch } from './tools/applypatch.ts'
export { logRun, runLogPath } from './runlog.ts'
export { findMemoryRoot, runLog, runSearch, runShow } from './tools/memory.ts'
export {
  listLessons,
  readLesson,
  searchLessons,
  slugifyLessonName,
  writeLesson,
  parseStdinLessonInput,
  type LessonWriteInput,
} from './tools/lesson.ts'
export {
  listNotes,
  listNoteCards,
  searchNotes,
  NOTES_INDEX_LIMIT,
  readNote,
  writeNote,
  type NoteCard,
  type NoteMeta,
} from './tools/note.ts'
export {
  computeMemoryStats,
  type LastReflect,
  type LibraryStat,
  type MemoryStats,
} from './tools/memory-stats.ts'
export { listSkills, readSkill, searchSkills } from './tools/skill.ts'
export type { PatchHunk, PatchChunk } from './tools/applypatch.ts'
export type { WebfetchConfig } from './tools/webfetch.ts'
export { createWebfetchTool } from './tools/webfetch.ts'
export type { WebsearchConfig } from './tools/websearch.ts'
export { createWebsearchTool } from './tools/websearch.ts'
export type {
  McpServerConfig,
  McpServers,
  McpToolInfo,
  McpCallResult,
} from './tools/mcp.ts'
export { listMcpTools, callMcpTool } from './tools/mcp.ts'
export { startCredentialProxy } from './proxy/credential-proxy.ts'
export { describeError } from './tools/describe.ts'
export type { EnsureShimsOptions, ShimEntry } from './shims.ts'
export { ensureShims, probeNode, resolveNodeBin } from './shims.ts'
export { PrefixBrokenError, findBreak, fingerprint } from './loop/prefix-guard.ts'
