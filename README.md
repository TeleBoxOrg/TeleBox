# TeleBox
## 简介
[TeleBox](https://github.com/TeleBoxDev/TeleBox) 是一个基于 **Node.js** 的 Telegram Bot 项目

## 使用方法
> 适用于 Debian / Ubuntu 系统。若使用其他发行版或 macOS，请根据平台调整包管理命令（例如 `yum` / `brew`）。

### 1. 更新并安装基础工具
```bash
sudo apt update
sudo apt install -y curl git build-essential
```

### 2. 安装 Node.js 20.x
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. 克隆项目

```bash
mkdir -p ~/telebox
cd ~/telebox
git clone https://github.com/TeleBoxDev/TeleBox.git .
```

### 4. 安装项目依赖
```bash
npm install
```

### 5. 启动
```bash
cd ~/telebox
```
```
npm start
```
需要填写：`api_id` 和 `api_hash`
Please enter your number: +18888888888
输入验证码
安装完成后 按下`CTRL+C`

### 6. 安装并使用 PM2 管理进程

```bash
npm install -g pm2
pm2 start npm --name telebox -- start
pm2 save
sudo pm2 startup systemd
```

```bash
pm2 logs telebox
```
查看运行日志。
