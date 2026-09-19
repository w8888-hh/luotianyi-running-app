# 洛天依陪跑应用 - 一键上传 GitHub 脚本
# 使用方法：右键 -> 使用 PowerShell 运行，或在 PowerShell 中执行 .\upload-to-github.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  洛天依陪跑应用 - GitHub 一键上传" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Git 是否安装
try {
    $gitVersion = git --version 2>&1
    Write-Host "[OK] Git 已安装: $gitVersion" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未检测到 Git，请先安装 Git" -ForegroundColor Red
    Write-Host "下载地址: https://git-scm.com/download/win" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit
}

# 检查 GitHub CLI 是否安装
$ghInstalled = $false
try {
    $ghVersion = gh --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] GitHub CLI 已安装" -ForegroundColor Green
        $ghInstalled = $true
    }
} catch {
    # 继续
}

if (-not $ghInstalled) {
    Write-Host "[警告] 未检测到 GitHub CLI (gh)" -ForegroundColor Yellow
    Write-Host "  安装方式: winget install --id GitHub.cli" -ForegroundColor Yellow
    Write-Host "  或者手动下载: https://cli.github.com/" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "没有 GitHub CLI 也可以手动上传，详见 UPLOAD.md" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit
}

Write-Host ""

# 检查登录状态
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[提示] 未登录 GitHub，开始登录流程..." -ForegroundColor Yellow
    Write-Host ""
    gh auth login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] 登录失败" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit
    }
}

Write-Host "[OK] GitHub 已登录" -ForegroundColor Green
Write-Host ""

# 获取用户输入
$defaultRepoName = "luotianyi-running-app"
$repoName = Read-Host "请输入仓库名称 (默认: $defaultRepoName)"
if ([string]::IsNullOrWhiteSpace($repoName)) {
    $repoName = $defaultRepoName
}

$defaultDesc = "洛天依陪跑应用 - 节拍器 + 心率监测 + 音乐播放 + 语音引导的跑步健身 Web 应用"
$desc = Read-Host "请输入仓库描述 (默认: $defaultDesc)"
if ([string]::IsNullOrWhiteSpace($desc)) {
    $desc = $defaultDesc
}

$visibility = Read-Host "公开仓库? (y/N，默认: 公开)"
if ($visibility -eq 'n' -or $visibility -eq 'N') {
    $visFlag = "--private"
    $visText = "私有"
} else {
    $visFlag = "--public"
    $visText = "公开"
}

Write-Host ""
Write-Host "仓库信息确认：" -ForegroundColor Cyan
Write-Host "  名称: $repoName"
Write-Host "  描述: $desc"
Write-Host "  可见性: $visText"
Write-Host ""

$confirm = Read-Host "确认创建并上传? (Y/n)"
if ($confirm -eq 'n' -or $confirm -eq 'N') {
    Write-Host "已取消" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit
}

Write-Host ""
Write-Host "正在初始化 Git 仓库..." -ForegroundColor Cyan

# 初始化 Git
if (-not (Test-Path .git)) {
    git init
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] Git 初始化失败" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit
    }
}

# 添加文件
git add .
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 添加文件失败" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit
}

# 提交
git commit -m "Initial commit: 洛天依陪跑应用"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[警告] 没有新文件需要提交（可能已经提交过了）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "正在创建 GitHub 仓库..." -ForegroundColor Cyan

# 创建 GitHub 仓库
gh repo create $repoName --description $desc $visFlag --source=. --remote=origin --push
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[错误] 创建仓库或推送失败" -ForegroundColor Red
    Write-Host ""
    Write-Host "可能的原因：" -ForegroundColor Yellow
    Write-Host "  1. 仓库名已存在"
    Write-Host "  2. 网络问题"
    Write-Host "  3. 权限不足"
    Write-Host ""
    Write-Host "可以尝试手动上传，详见 UPLOAD.md" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  上传成功！🎉" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# 获取仓库 URL
$repoUrl = gh repo view --json url --jq '.url' 2>&1
if ($repoUrl) {
    Write-Host "仓库地址: $repoUrl" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "后续更新代码只需运行："
Write-Host "  git add ."
Write-Host "  git commit -m '更新说明'"
Write-Host "  git push"
Write-Host ""

# 询问是否打开浏览器
$open = Read-Host "是否在浏览器中打开仓库? (Y/n)"
if ($open -ne 'n' -and $open -ne 'N') {
    gh repo view --web
}

Write-Host ""
Write-Host "按回车键退出"
Read-Host
