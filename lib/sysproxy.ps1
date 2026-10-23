# dsh-flowspot：告诉 WinINet 代理设置已经变了。
#
# 写 HKCU\...\Internet Settings 只是改了注册表。已经在运行的应用程序会一直用缓存里的
# 旧设置，直到有人调 InternetSetOption 为止，所以插件每次改完注册表都要跑这个脚本。
# 这是用户级调用，不需要提权。
param(
    [switch]$Notify
)

$ErrorActionPreference = 'Stop'

# 用 P/Invoke 调 wininet.dll 的 InternetSetOption。Node 侧没有现成接口，只能借
# PowerShell 现场编译这段 C# 再调用。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshWebCaptureWinInet
{
    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@

if ($Notify) {
    # 39 = INTERNET_OPTION_SETTINGS_CHANGED（设置改了），37 = INTERNET_OPTION_REFRESH（刷新缓存）
    # 两个都得调：39 让进程知道配置变了，37 让已缓存的连接参数失效。
    $changed = [DshWebCaptureWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    $refreshed = [DshWebCaptureWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
    Write-Output ("notified changed={0} refreshed={1}" -f $changed, $refreshed)
}
