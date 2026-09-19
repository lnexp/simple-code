const ENV_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * 展开 `${ENV_NAME}`。
 *
 * 只识别**整个值就是一个 ${} 引用**的形式，不做字符串内插。理由：
 * `"Bearer ${KEY}"` 这种半引用的形式一旦支持，就要处理转义、部分展开失败
 * 怎么办等一堆边界，而它解决的问题（拼前缀）本来就该由协议层做。
 *
 * 环境变量不存在时**报错**，不回落到空串——回落的话请求会带着空 key 发出去，
 * 收到 401 时用户完全猜不到是环境变量没设。
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = ENV_PATTERN.exec(value)
  if (!match) return value

  const name = match[1] as string
  const resolved = env[name]
  if (resolved === undefined || resolved === '') {
    // 只说变量名，绝不回显值——这个函数的典型输入就是 API key
    throw new Error(`配置引用了环境变量 ${name}，但它没有设置（或为空）`)
  }
  return resolved
}
