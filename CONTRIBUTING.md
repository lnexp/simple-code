# 贡献指南

感谢你有兴趣给 SimpleCode 提交改动。

## 分支

- **PR 请发到 `dev` 分支**（`main` 只放发布快照，直接发 main 会被关闭）
- `main` 的每次推进都是一个版本；开发与讨论都在 `dev`

## 当前边界：功能冻结

SimpleCode 处于**功能冻结**阶段：只收 bug 修复、稳定性、协议健壮性、观测补全与
文档改进。**不收新功能**——想做的功能请先开 issue 讨论，避免你写完了被拒。

## 提交前请验证

```bash
npx tsc --noEmit -p packages/core
npx tsc --noEmit -p packages/vscode
npx tsc --noEmit -p packages/cli
npx vitest run
npx biome check <你改的文件>
```

全绿再发 PR。改动请附上能复现问题的测试（修 bug）或保持全量测试通过（其他改动）。

## 其他约定

- commit message：一行简短说明（中英文均可）
- 不引入新依赖，除非 PR 描述里说明为什么绕不开
- 涉及隐私的路径、域名、密钥不要出现在提交里
