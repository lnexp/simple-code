import { mkdir } from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch, parsePatch } from '../src/tools/applypatch.ts'

/** 每个用例一个干净沙箱。IO 全走真实文件——这个模块的职责就是落盘语义 */
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'simple-code-applypatch-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const W = (rel: string, text: string): Promise<void> => writeFile(join(root, rel), text)
const R = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

describe('parsePatch 语法', () => {
  it('三件套都解析得出：add 行、delete、update 的 context/-/+ 与 @@、Move to、End of File', () => {
    const hunks = parsePatch(`*** Begin Patch
*** Add File: a.txt
+hello
+
+world
*** Delete File: b.txt
*** Update File: src/c.ts
*** Move to: src/d.ts
@@ class Foo
 ctx1
-old1
+new1
 ctx2
+extra
*** End of File
*** End Patch`)
    expect(hunks).toHaveLength(3)
    expect(hunks[0]).toEqual({ kind: 'add', path: 'a.txt', lines: ['hello', '', 'world'] })
    expect(hunks[1]).toEqual({ kind: 'delete', path: 'b.txt' })
    const u = hunks[2]
    expect(u?.kind).toBe('update')
    if (u?.kind !== 'update') return
    expect(u.path).toBe('src/c.ts')
    expect(u.moveTo).toBe('src/d.ts')
    expect(u.chunks).toHaveLength(1)
    const c = u.chunks[0]
    expect(c?.context).toEqual(['class Foo'])
    expect(c?.oldLines).toEqual(['ctx1', 'old1', 'ctx2'])
    expect(c?.newLines).toEqual(['ctx1', 'new1', 'ctx2', 'extra'])
    expect(c?.added).toBe(2)
    expect(c?.removed).toBe(1)
    expect(c?.endOfFile).toBe(true)
  })

  it('update 不写 @@ 直接给行（隐式 chunk）；裸空行按 lenient 收进上下文', () => {
    const hunks = parsePatch(`*** Begin Patch
*** Update File: x.ts
 a

-b
+c
*** End Patch`)
    const c = hunks[0]?.kind === 'update' ? hunks[0].chunks[0] : undefined
    expect(c?.oldLines).toEqual(['a', '', 'b'])
    expect(c?.newLines).toEqual(['a', '', 'c'])
  })

  it("lenient：heredoc 壳（<<'EOF' … EOF）剥掉再解析", () => {
    const hunks = parsePatch(`<<'PATCH'
*** Begin Patch
*** Delete File: g.txt
*** End Patch
PATCH`)
    expect(hunks).toEqual([{ kind: 'delete', path: 'g.txt' }])
  })

  it('语法错误都带行号：无 Begin、无 End、Add 里混入普通行、update 无 chunk、chunk 无上下文行', () => {
    expect(() => parsePatch('*** Update File: x\n@@\n-a\n+b\n*** End Patch')).toThrow(/第 1 行/)
    expect(() => parsePatch('*** Begin Patch\n*** Delete File: x\n')).toThrow(/End/)
    expect(() => parsePatch('*** Begin Patch\n*** Add File: x\nhello\n*** End Patch')).toThrow(
      /必须以 \+ 开头/,
    )
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n*** End Patch')).toThrow(
      /至少要一个 @@ chunk/,
    )
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n@@\n+a\n*** End Patch')).toThrow(
      /无法定位/,
    )
  })
  it('update 里夹了中间的 *** End Patch（多文件各写一对 Begin/End）：报语法错误，不当上下文吃进 chunk', () => {
    // 2026-09-30 实案：曾被 lenient 收成上下文行，报「找不到要替换的行（第 1 行是…）」，
    // 而第 1 行在文件里明明存在——真正对不上的是 chunk 末尾这行
    const two = '*** Begin Patch\n*** Update File: a\n@@\n ctx\n+x\n*** End Patch\n*** Update File: b\n@@\n ctx\n+y\n*** End Patch'
    expect(() => parsePatch(two)).toThrow(/补丁第 6 行：.*\*\*\* End Patch.*一对 Begin\/End/)
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a\n@@\n ctx\n*** Begin Patch\n+x\n*** End Patch')).toThrow(
      /补丁第 5 行/,
    )
    // End of File / Move to 仍是合法标记
    expect(parsePatch('*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n ctx\n+x\n*** End of File\n*** End Patch')).toHaveLength(1)
  })
  it('报错行号是 1 起算的真实行号（曾为 0 起算下标，少 1）', () => {
    // 第 3 行：Add 里混入普通行
    expect(() => parsePatch('*** Begin Patch\n*** Add File: x\nhello\n*** End Patch')).toThrow(/补丁第 3 行/)
    // 第 3 行：End of File 不在 chunk 内
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n*** End of File\n*** End Patch')).toThrow(/补丁第 3 行/)
    // 第 3 行：chunk（@@ 所在行）没有上下文
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n@@\n+a\n*** End Patch')).toThrow(/补丁第 3 行/)
    // 第 3 行：隐式 chunk 起始行
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n+a\n*** End Patch')).toThrow(/补丁第 3 行/)
    // 结尾缺 End：指最后一个非空行（第 2 行），不指末尾换行后的空串
    expect(() => parsePatch('*** Begin Patch\n*** Delete File: x\n')).toThrow(/补丁第 2 行/)
    expect(() => parsePatch('*** Begin Patch\n*** Delete File: x')).toThrow(/补丁第 2 行/)
  })
})

describe('applyPatch 应用', () => {
  it('绝对路径原样使用——不被拼进工作区根（曾是幽灵路径报「不存在」）', async () => {
    // 场景：改家目录配置这类工作区外目标。字符串拼接时代它拼出
    // cwd + 绝对路径 → 文件明明存在却报不存在
    const outside = await mkdtemp(join(tmpdir(), 'simple-code-outside-'))
    try {
      const target = join(outside, 'settings.json')
      await writeFile(target, 'a\nb\n', 'utf8')
      const summary = await applyPatch(
        root,
        ['*** Begin Patch', `*** Update File: ${target}`, '@@', '-b', '+B', '*** End Patch'].join('\n'),
      )
      expect(summary).toContain('settings.json +1/-1')
      expect(await readFile(target, 'utf8')).toBe('a\nB\n')
      // 补丁里的路径显示原样（绝对路径就显示绝对路径），不猜相对
      expect(summary).toContain(target)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
  it('update：多 chunk 顺序替换，摘要 +N/-M', async () => {
    await W('m.ts', 'one\ntwo\nthree\nfour\nfive\n')
    const out = await applyPatch(root, `*** Begin Patch
*** Update File: m.ts
@@
-one
+ONE
@@
-four
+FOUR
+FOUR2
*** End Patch`)
    expect(await R('m.ts')).toBe('ONE\ntwo\nthree\nFOUR\nFOUR2\nfive\n')
    expect(out).toBe('m.ts +3/-2')
  })

  it('chunk 之间不回退：第二处改动在第一处之后找（相同上下文不会误伤第一处）', async () => {
    await W('dup.ts', 'head\nx\nhead\nx\n')
    await applyPatch(root, `*** Begin Patch
*** Update File: dup.ts
@@
 x
+y1
@@
 x
+y2
*** End Patch`)
    expect(await R('dup.ts')).toBe('head\nx\ny1\nhead\nx\ny2\n')
  })

  it('End of File 锚：末尾追加', async () => {
    await W('t.txt', 'a\nb\n')
    await applyPatch(root, `*** Begin Patch
*** Update File: t.txt
@@
 b
+tail
*** End of File
*** End Patch`)
    expect(await R('t.txt')).toBe('a\nb\ntail\n')
  })

  it('CRLF 文件靠二级模糊（trimEnd 吃 \\r）匹配成功', async () => {
    await W('crlf.txt', 'a\r\nb\r\n')
    await applyPatch(root, `*** Begin Patch
*** Update File: crlf.txt
@@
-b
+B
*** End Patch`)
    expect(await R('crlf.txt')).toBe('a\r\nB\n')
  })

  it('add 建新文件（含新目录、末尾换行）；delete 删文件', async () => {
    await W('gone.txt', 'bye\n')
    const out = await applyPatch(root, `*** Begin Patch
*** Add File: deep/new/a.txt
+one
+two
*** Delete File: gone.txt
*** End Patch`)
    expect(out).toContain('deep/new/a.txt +2/-0')
    expect(await R('deep/new/a.txt')).toBe('one\ntwo\n')
    await expect(stat(join(root, 'gone.txt'))).rejects.toThrow()
  })

  it('Move to：写新路径删旧路径', async () => {
    await W('old.ts', 'a\n')
    await applyPatch(root, `*** Begin Patch
*** Update File: old.ts
*** Move to: dir/new.ts
@@
-a
+b
*** End Patch`)
    expect(await R('dir/new.ts')).toBe('b\n')
    await expect(stat(join(root, 'old.ts'))).rejects.toThrow()
  })

  it('找不到上下文：报文件名和首行，整盘不写（原子性）', async () => {
    await W('ok.txt', 'fine\n')
    await W('bad.txt', 'actual\n')
    await expect(
      applyPatch(root, `*** Begin Patch
*** Update File: ok.txt
@@
 fine
+ appended
*** Update File: bad.txt
@@
 not-in-file
+ x
*** End Patch`),
    ).rejects.toThrow(/bad\.txt：找不到要替换的行——首行「not-in-file」在文件里找不到/)
    // ok.txt 不该被改——补丁是整体的，第二块失败第一块也不落盘
    expect(await R('ok.txt')).toBe('fine\n')
    expect(await R('bad.txt')).toBe('actual\n')
  })

  // 报错指出哪一行对不上（note apply-patch-mismatch-replay：129 次失败回放，
  // 只给首行时 37 次首行其实在、26 次漏抄中间一行——报错指错了地方）
  describe('找不到上下文：指出第一处不一致', () => {
    const fails = async (file: string, body: string): Promise<string> => {
      await W('f.txt', file)
      const err = await applyPatch(root, `*** Begin Patch\n*** Update File: f.txt\n${body}\n*** End Patch`).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(await R('f.txt')).toBe(file)
      return (err as Error).message
    }

    it('首行在、后面某行抄错（t17121 注释折行 reach / reach the）：报对上的范围与两边原文', async () => {
      const msg = await fails(
        'x\n/**\n * went to reasoning. Re-think (only the steps needed to reach the\n * answer) directly.\n */\n',
        '@@\n /**\n- * went to reasoning. Re-think (only the steps needed to reach\n+ * new',
      )
      expect(msg).toContain('前 1 行对上了文件第 2 行')
      expect(msg).toContain('补丁：「 * went to reasoning. Re-think (only the steps needed to reach」')
      expect(msg).toContain('文件第 3 行：「 * went to reasoning. Re-think (only the steps needed to reach the」')
    })

    it('漏抄中间一行（某真实项目 t775 漏 @Test）：文件那一行就是被漏掉的', async () => {
      const msg = await fails('  }\n\n  @Test\n  void foo() {\n', '@@\n   }\n \n-  void foo() {\n+  void bar() {')
      expect(msg).toContain('前 2 行对上了文件第 1–2 行')
      expect(msg).toContain('文件第 3 行：「  @Test」')
    })

    it('首行就不存在但有近似行（t16975 xli / xcli）：给最像的那行', async () => {
      const msg = await fails(
        "a\n      await tool.execute({ command: 'xcli get f.pptx /slide[2]', cwd: root }, ctx)\nb\n",
        "@@\n-      await tool.execute({ command: 'xli get f.pptx /slide[2]', cwd: root }, ctx)\n+      x",
      )
      expect(msg).toContain("首行「      await tool.execute({ command: 'xli get f.pptx /slide[2]', cwd: root }, ctx)」在文件里找不到")
      expect(msg).toContain("最像的是文件第 2 行：「      await tool.execute({ command: 'xcli get f.pptx /slide[2]', cwd: root }, ctx)」")
    })

    it('首行找不到也没有近似行：提示先重读文件', async () => {
      const msg = await fails('alpha\nbeta\n', '@@\n-totally different line\n+x')
      expect(msg).toContain('首行「totally different line」在文件里找不到')
      expect(msg).toContain('先重新读一遍文件')
    })

    it('chunk 顺序写反（后面的写在前）：提示按文件顺序排', async () => {
      const msg = await fails('one\ntwo\nthree\nfour\n', '@@\n-four\n+FOUR\n@@\n-two\n+TWO')
      expect(msg).toContain('在上一个 chunk 之前')
      expect(msg).toContain('按文件里的先后顺序')
    })

    it('整段都在但带 End of File 锚、不在末尾：点明是锚的问题', async () => {
      const msg = await fails('a\nb\nc\n', '@@\n-a\n+A\n*** End of File')
      expect(msg).toContain('这段在文件第 1 行，但不在文件末尾')
    })
  })

  it('add 已存在 / update 不存在 / delete 不存在 / 同文件两次，都拒绝', async () => {
    await W('exists.txt', 'x\n')
    await expect(
      applyPatch(root, '*** Begin Patch\n*** Add File: exists.txt\n+x\n*** End Patch'),
    ).rejects.toThrow(/已存在，Add File 不能覆盖/)
    await expect(
      applyPatch(root, '*** Begin Patch\n*** Update File: nope.ts\n@@\n a\n+b\n*** End Patch'),
    ).rejects.toThrow(/nope\.ts：不存在/)
    await expect(
      applyPatch(root, '*** Begin Patch\n*** Delete File: nope.ts\n*** End Patch'),
    ).rejects.toThrow(/不存在/)
    await expect(
      applyPatch(
        root,
        '*** Begin Patch\n*** Delete File: exists.txt\n*** Update File: exists.txt\n@@\n x\n+y\n*** End Patch',
      ),
    ).rejects.toThrow(/出现了两次/)
  })

  it('空目录残留检查：delete 后目录留着（不递归清目录）', async () => {
    await mkdir(join(root, 'sub'))
    await W('sub/x.txt', '1\n')
    await applyPatch(root, '*** Begin Patch\n*** Delete File: sub/x.txt\n*** End Patch')
    expect(await readdir(join(root, 'sub'))).toEqual([])
  })
})
