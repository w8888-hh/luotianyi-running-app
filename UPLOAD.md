# 上传到 GitHub 指南

## 方法一：一键上传脚本（推荐）

### 前置条件
1. 安装 Git：https://git-scm.com/download/win
2. 安装 GitHub CLI：https://cli.github.com/
   - 或运行：`winget install --id GitHub.cli`

### 上传步骤

1. **登录 GitHub**（第一次需要）
   ```bash
   gh auth login
   ```
   按提示选择：
   - GitHub.com
   - HTTPS
   - 登录浏览器认证

2. **运行上传脚本**
   双击 `upload-to-github.ps1`，或在 PowerShell 中运行：
   ```powershell
   .\upload-to-github.ps1
   ```

3. **按提示输入**
   - 仓库名称（默认：luotianyi-running-app）
   - 仓库描述（默认：洛天依陪跑应用）
   - 是否公开（默认：公开）

脚本会自动：
- 初始化 Git 仓库
- 创建首次提交
- 在 GitHub 创建仓库
- 推送所有代码

---

## 方法二：手动上传

### 1. 创建 GitHub 仓库
1. 打开 https://github.com/new
2. 填写仓库名：`luotianyi-running-app`
3. 填写描述：`洛天依陪跑应用 - 节拍器 + 心率监测 + 音乐播放 + 语音引导`
4. 选择 Public（公开）或 Private（私有）
5. 不要勾选 "Initialize this repository with a README"
6. 点击 "Create repository"

### 2. 本地初始化并推送

在项目目录下打开 Git Bash 或 PowerShell：

```bash
# 初始化 Git
git init

# 添加所有文件
git add .

# 创建首次提交
git commit -m "Initial commit: 洛天依陪跑应用"

# 添加远程仓库（替换 YOUR_USERNAME 为你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USERNAME/luotianyi-running-app.git

# 推送到 GitHub
git branch -M main
git push -u origin main
```

### 3. 刷新 GitHub 页面
代码就上传成功了！

---

## 方法三：GitHub网页上传（最简单）

1. 打开 https://github.com/new 创建仓库
2. 仓库名：`luotianyi-running-app`
3. 勾选 "Add a README file"（先随便创建）
4. 创建仓库后，点击 "Add file" → "Upload files"
5. 把项目文件夹里的所有文件拖进去
6. 点击 "Commit changes"

---

## 后续更新代码

修改代码后，在项目目录运行：

```bash
git add .
git commit -m "更新说明"
git push
```

## 常用 Git 命令

```bash
git status          # 查看当前状态
git diff            # 查看修改内容
git log             # 查看提交历史
git pull            # 拉取最新代码
```
