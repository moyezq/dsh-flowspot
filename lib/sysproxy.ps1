# dsh-flowspot: tell WinINet that the proxy settings changed.
#
# Writing HKCU\...\Internet Settings only updates the registry. Already running
# applications keep their cached settings until InternetSetOption is called, so
# the plugin runs this script after every registry change. User-level call, no
# elevation.
param(
    [switch]$Notify
)

$ErrorActionPreference = 'Stop'

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
    # 39 = INTERNET_OPTION_SETTINGS_CHANGED, 37 = INTERNET_OPTION_REFRESH
    $changed = [DshWebCaptureWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    $refreshed = [DshWebCaptureWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
    Write-Output ("notified changed={0} refreshed={1}" -f $changed, $refreshed)
}
