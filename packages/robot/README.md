# SimpleCode Robot

[SimpleCode](https://marketplace.visualstudio.com/items?itemName=lnexp.simplecode-agent) 的桌面机器人，**仅支持 macOS**。

别的应用（浏览器、聊天软件……）盖住 VS Code 时，机器人浮在屏幕上层提醒你 SimpleCode 的事：

- **审批卡**：直接点「允许」。`git push`、`gh` 这类命令和出网命令只能点「回窗口」，到面板里处理。
- **任务结束**：显示结论的第一句，以及是完成还是出错。
- **跳回去**：点任一条，回到对应的 VS Code 窗口、目录和任务。
- **总览**：点菜单栏图标或右键机器人，列出所有窗口、目录、任务的状态。

没事时机器人不出现，只留菜单栏图标。

## 开关

- 命令面板「SimpleCode Robot: 关闭桌面机器人」/「开启桌面机器人」。
- 右键机器人 →「关闭机器人」，效果同关闭命令。
- 配置文件 `~/.simple-code/robot/config.json` 的 `enabled`。

## 皮肤

右键机器人 →「打开皮肤目录」（`~/.simple-code/robot/skins/`），新建一个文件夹，放
`idle`、`working`、`waiting`、`done`、`error` 五张图（svg / png / gif，缺的用 `idle` 补），
再在右键菜单「皮肤」里选它。
