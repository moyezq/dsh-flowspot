/**
 * `systemBin` 的契约：System32 下的系统命令优先解析成绝对路径，解析不出来就
 * 退回裸命令名。这个模块存在的唯一理由是「由 GUI 启动的进程 PATH 可能不含
 * System32」——Electron 打包的 DSH Desktop 就是这种场景，拿不到 certutil 会
 * 表现为 CA 装不上。
 *
 * 运行：node test/sysbin.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { systemBin } from '../lib/sysbin.js'

test('resolves System32 commands to an absolute path when the file exists', () => {
  const exists = (p) => p === 'C:\\Windows\\System32\\certutil.exe'
  assert.equal(systemBin('certutil.exe', { platform: 'win32', systemRoot: 'C:\\Windows', exists }), 'C:\\Windows\\System32\\certutil.exe')
  // 不带 .exe 也认
  assert.equal(systemBin('certutil', { platform: 'win32', systemRoot: 'C:\\Windows', exists }), 'C:\\Windows\\System32\\certutil.exe')
  // 自定义 SystemRoot（比如装在 D 盘的 Windows）
  const existsD = (p) => p === 'D:\\Windows\\System32\\powershell.exe'
  assert.equal(systemBin('powershell.exe', { platform: 'win32', systemRoot: 'D:\\Windows', exists: existsD }), 'D:\\Windows\\System32\\powershell.exe')
})

test('falls back to the bare name instead of guessing', () => {
  const missing = () => false
  // 文件不在：退回裸名，让系统按 PATH 再试一次，而不是给一个不存在的路径
  assert.equal(systemBin('reg.exe', { platform: 'win32', systemRoot: 'C:\\Windows', exists: missing }), 'reg.exe')
  // 非 Windows：原样返回（插件在非 Windows 上本来就走 supported=false 的分支）
  assert.equal(systemBin('certutil.exe', { platform: 'darwin', systemRoot: 'C:\\Windows', exists: () => true }), 'certutil.exe')
  // 不在白名单：不当系统命令处理，原样返回（例如我们自己拼的 Chrome 路径）
  assert.equal(systemBin('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { platform: 'win32', exists: () => true }), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  // 空名字直接报错，避免拼出 System32\ 这种目录路径
  assert.throws(() => systemBin(''), /没有命令名/)
})
