<div align="center">

# 📋 TeleBox 安装指南

> 💡 你是什么也不懂的小白吗？查看如何使用我们的 [一键部署脚本](https://github.com/TeleBoxOrg/TeleBox_Scripts)

[![Node.js](https://img.shields.io/badge/Node.js-24.x-green.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-LGPL--2.1-blue?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=for-the-badge)](#)

</div>

## 🎯 项目简介

[**TeleBox**](https://github.com/TeleBoxOrg/TeleBox) 是基于 **Node.js** 与 **TypeScript** 构建的现代化 Telegram UserBot 开发框架，提供强大的插件系统和丰富的功能模块。

## 🚀 部署指南

<div align="center">

### 🐧 **支持平台**

![Debian](https://img.shields.io/badge/Debian-A81D33?style=flat-square&logo=debian&logoColor=white)
![Ubuntu](https://img.shields.io/badge/Ubuntu-E95420?style=flat-square&logo=ubuntu&logoColor=white)
![CentOS](https://img.shields.io/badge/CentOS-262577?style=flat-square&logo=centos&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)

</div>

> 📝 **说明：** 以下步骤适用于 **Debian / Ubuntu** 系统，其他发行版或 macOS 请根据平台调整包管理命令（如 `yum` / `brew`）。

### 🔧 **步骤 1：更新并安装基础工具**

<details>
<summary><b>💻 点击展开命令详情</b></summary>

```bash
# 🔄 更新系统包列表
sudo apt update

# 📦 安装必需的基础工具
sudo apt install -y curl git build-essential
```

**📋 安装组件说明：**

- `curl` - 用于下载 Node.js 安装脚本
- `git` - 版本控制工具，用于克隆项目
- `build-essential` - 编译工具链，用于构建原生模块

</details>

### 🟢 **步骤 2：安装 Node.js 24.x（当前支持版本）**

<details>
<summary><b>🚀 点击展开安装步骤</b></summary>

```bash
# 📥 下载并执行 Node.js 24.x 安装脚本
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -

# 📦 安装 Node.js 和 npm
sudo apt-get install -y nodejs
```

#### 若已使用 Node.js 版本管理工具

本项目中已提供了 `.nvmrc` 文件，通常 Node.js 版本管理工具会自动识别，并在当前工作区切换到项目当前支持的 Node.js 24.x。

**✅ 验证安装：**

```bash
node --version    # 应显示 v24.x.x
npm --version     # 应显示对应的 npm 版本
```

</details>

### 📂 **步骤 3：克隆项目**

<details>
<summary><b>📥 点击展开克隆步骤</b></summary>

```bash
# 📁 创建项目目录
mkdir -p ~/telebox

# 📂 进入项目目录
cd ~/telebox

# 🔄 克隆 TeleBox 项目
git clone https://github.com/TeleBoxOrg/TeleBox.git .
```

**📋 目录结构：**

```
~/telebox/
├── src/           # 源代码
├── plugins/       # 插件目录
├── package.json  # 项目配置
└── README.md      # 项目文档
```

</details>

### 📦 **步骤 4：安装项目依赖**

<details>
<summary><b>⚡ 点击展开安装过程</b></summary>

```bash
# 📥 安装所有项目依赖
npm install
```

**🔄 安装过程说明：**

- 自动下载并安装 `package.json` 中定义的所有依赖
- 安装完成后生成 `node_modules/` 目录

**⏱️ 预计耗时：** 2-5 分钟（取决于网络速度）

</details>

### ⚙️ **步骤 5：首次启动配置**

<details>
<summary><b>🔐 点击展开配置步骤</b></summary>

```bash
# 📂 确保在项目目录
cd ~/telebox

# 🚀 启动 TeleBox
npm start
```

**📝 配置流程：**

1. **🔑 API 凭据配置**

   ```
   需要填写：api_id 和 api_hash
   ```

   > 💡 从 [my.telegram.org](https://my.telegram.org) 获取 API 凭据
   
   > 🤔 申请不到 API 凭据？尝试使用 [TeleBox API频道](https://t.me/TeleBox_API) 中的 API 凭据

2. **📱 选择登录方式**

   ```
   Use QR code login? [y/N]:
   ```

   > - 输入 `y` 使用**二维码登录**：在手机 Telegram 中扫描屏幕上的二维码
   > - 输入 `N` 或直接回车使用**手机号登录**

3. **📱 手机号登录（如选择手机号登录）**

   ```
   Enter phone number (+86...):
   Enter the verification code:
   Enter 2FA password (if any):
   ```

   > 按顺序输入手机号、收到的验证码、密码（如开启两步验证）

4. **✅ 登录成功确认**
   ```
   [INFO] - [Signed in successfully as xxx]
   ```
   > 🎉 看到此消息表示登录成功，TeleBox 正在运行
   
   > 💡 **接下来：** 现在可以在 Telegram 中向自己发送命令测试（如 `.help`），确认后按 `CTRL+C` 停止，然后继续步骤 6 进行生产环境部署

</details>

### ⚙️ **步骤 6：生产环境部署**

<details>
<summary><b>🔄 点击展开 PM2 部署步骤</b></summary>

**📦 安装 PM2 进程管理器：**

```bash
# 全局安装 PM2
npm install -g pm2
```

**🚀 启动 TeleBox 服务：**

```bash
# 使用 PM2 启动服务
pm2 start "npm start" --name telebox

# 保存 PM2 配置
pm2 save

# 设置开机自启动
pm2 startup systemd
```

**📊 监控和管理：**

```bash
# 查看服务状态
pm2 status

# 查看运行日志
pm2 logs telebox

# 🔄 重启服务
pm2 restart telebox

# 🛑 停止服务
pm2 stop telebox

# 🗑️ 删除进程
pm2 delete telebox
```

**🧰 可选增强功能：**

```bash
# 📦 安装日志管理和分割插件
pm2 install pm2-logrotate

# 📊 实时监控面板
pm2 monit

# 🔄 无缝重载（零停机时间）
pm2 reload telebox

# 📋 查看所有进程
pm2 list
```

</details>

---

## 🔧 常见问题排查

<details>
<summary><b>❓ 登录问题</b></summary>

**问题：无法获取验证码**
- 确认手机号格式正确（需要包含国际区号，如 `+86`）
- 检查 Telegram 账号是否正常
- 尝试使用二维码登录方式（输入 `y`）

**问题：API 凭据无效**
- 确认从 [my.telegram.org](https://my.telegram.org) 正确复制了 `api_id` 和 `api_hash`
- 检查 `config.json` 文件格式是否正确（JSON 格式）
- 尝试使用 [TeleBox API频道](https://t.me/TeleBox_API) 提供的备用凭据

**问题：代理连接失败**
- 如需使用代理，在 `config.json` 中正确配置 `proxy` 字段：
  ```json
  {
    "api_id": "your_api_id",
    "api_hash": "your_api_hash",
    "proxy": {
      "ip": "127.0.0.1",
      "port": 7890,
      "socksType": 5
    }
  }
  ```

</details>

<details>
<summary><b>❓ 依赖安装问题</b></summary>

**问题：`npm install` 失败**
- 确认 Node.js 版本为 24.x：`node --version`
- 清理缓存后重试：
  ```bash
  npm cache clean --force
  rm -rf node_modules package-lock.json
  npm install
  ```

**问题：原生模块编译失败（如 sharp、better-sqlite3）**
- 确认已安装编译工具：
  ```bash
  # Debian/Ubuntu
  sudo apt install -y build-essential python3
  
  # CentOS/RHEL
  sudo yum groupinstall "Development Tools"
  sudo yum install python3
  ```

**问题：网络超时**
- 配置 npm 镜像源：
  ```bash
  npm config set registry https://registry.npmmirror.com
  ```

</details>

<details>
<summary><b>❓ 运行问题</b></summary>

**问题：PM2 启动后立即退出**
- 查看错误日志：`pm2 logs telebox --err`
- 确认首次启动配置（步骤 5）已完成
- 检查 `config.json` 和 `.env` 文件是否存在

**问题：命令无响应**
- 确认使用了正确的命令前缀（默认为 `.` 或 `。`）
- 检查 PM2 进程状态：`pm2 status`
- 查看实时日志：`pm2 logs telebox`

**问题：权限不足**
- 某些命令需要 sudo 权限，使用 `.sudo add <user_id>` 添加管理员
- 获取自己的 user_id：`.id`

</details>

---

<div align="center">

## 🎉 **部署完成**

**TeleBox 现在已成功部署并运行！**

[![返回主页](https://img.shields.io/badge/🏠_返回主页-README.md-blue?style=for-the-badge)](https://github.com/TeleBoxOrg/TeleBox/blob/main/README.md)



如有问题，请[**🆘 问题反馈**](https://github.com/TeleBoxOrg/TeleBox/issues)

</div>
