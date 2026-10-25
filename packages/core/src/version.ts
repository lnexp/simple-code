// 扩展版本号：四个 package.json 同步升版（chore: 0.1.x），取 core 的。
// 前缀守卫用它区分「用户升级」与「同版本内改写」
import pkg from '../package.json' with { type: 'json' }

export const SC_VERSION: string = pkg.version
