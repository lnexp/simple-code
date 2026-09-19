import { describe, expect, it } from 'vitest'
import { bestCandidate, suffixSegments } from '../src/openfile-resolve.ts'

/** 样例来自真实误报：Java 包片段路径 */
describe('openFile 兜底解析', () => {
  it('suffixSegments：尾部连续段对齐', () => {
    const segs = ['domain', 'entity', 'X.java']
    expect(suffixSegments('/w/src/main/java/com/a/domain/entity/X.java', segs)).toBe(2)
    expect(suffixSegments('/w/domain/entity/X.java', segs)).toBe(2)
    expect(suffixSegments('/w/src/test/java/com/a/entity/X.java', segs)).toBe(1)
  })

  it('bestCandidate：对齐多者优先，并列取浅', () => {
    const segs = ['domain', 'entity', 'X.java']
    const pick = bestCandidate(segs, [
      '/w/src/main/java/com/a/domain/entity/X.java',
      '/w/other/deep/pkg/X.java',
      '/w/src/main/java/com/a/domain/entity/sub/X.java', // basename 撞车（同名文件）
    ])
    // 第一个与第三个对齐都是 2，取路径短的（非 sub）
    expect(pick).toBe('/w/src/main/java/com/a/domain/entity/X.java')
  })

  it('单 basename 命中也返回（0 段对齐）', () => {
    expect(bestCandidate(['X.java'], ['/w/anywhere/X.java'])).toBe('/w/anywhere/X.java')
  })

  it('空候选返回 null', () => {
    expect(bestCandidate(['a', 'b'], [])).toBeNull()
  })
})
