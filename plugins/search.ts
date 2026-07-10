import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto/tl";
import { CustomFile } from "teleproto/client/uploads";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import fs from "fs/promises";
import path from "path";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const CONFIG_FILE_PATH = path.join(
  process.cwd(),
  "temp",
  "channel_search_config.json"
);

interface SearchConfig {
  defaultChannel: string | null;
  channelList: { title: string; handle: string; linkedGroup?: string }[];
  adFilters: string[];
}

enum SubCommand {
  Add = "add",
  Delete = "del",
  Default = "default",
  List = "list",
  Export = "export",
  Import = "import",
  Kkp = "kkp",
  Ad = "ad",
}

class SearchService {
  private client: any;
  private config: SearchConfig = {
    defaultChannel: null,
    channelList: [],
    adFilters: [
      "广告", "推广", "赞助", "合作", "代理", "招商", "加盟", "投资", "理财",
      "贷款", "借钱", "网贷", "信用卡", "pos机", "刷单", "兼职", "副业",
      "微商", "代购", "淘宝", "拼多多", "京东", "直播带货", "优惠券",
      "返利", "红包", "现金", "提现", "充值", "游戏币", "点卡",
      "彩票", "博彩", "赌博", "六合彩", "时时彩", "北京赛车",
      "股票", "期货", "外汇", "数字货币", "比特币", "挖矿",
      "保险", "医疗", "整容", "减肥", "丰胸", "壮阳", "药品",
      "假货", "高仿", "A货", "精仿", "原单", "尾单",
      "办证", "刻章", "发票", "学历", "文凭", "证书",
      "黑客", "破解", "外挂", "木马", "病毒", "盗号",
      "vpn", "翻墙", "代理ip", "科学上网", "梯子"
    ]
  };

  constructor(client: any) {
    this.client = client;
  }

  public async initialize() {
    await this.loadConfig();
  }

  private async loadConfig() {
    try {
      await fs.access(CONFIG_FILE_PATH);
      const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
      this.config = { ...this.config, ...JSON.parse(data) };
    } catch (error) {
      console.log("未找到搜索配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("保存配置失败:", error);
    }
  }

  private async discoverLinkedGroup(channel: Api.Channel): Promise<string | undefined> {
    try {
      const fullChannel = await this.client.invoke(
        new Api.channels.GetFullChannel({
          channel: channel,
        })
      );

      if (fullChannel.fullChat.linkedChatId) {
        const linkedChatId = fullChannel.fullChat.linkedChatId;
        const linkedGroup = await this.client.getEntity(linkedChatId);
        if (linkedGroup instanceof Api.Channel && linkedGroup.megagroup) {
          if (linkedGroup.username) {
            return `@${linkedGroup.username}`;
          } else {
            try {
              const inviteLink = await this.client.invoke(
                new Api.messages.ExportChatInvite({
                  peer: linkedGroup
                })
              );
              if (inviteLink instanceof Api.ChatInviteExported) {
                return inviteLink.link;
              }
            } catch (linkError: any) {
              console.log(`获取邀请链接失败: ${linkError.message}`);
            }
            return undefined;
          }
        }
      }
      return undefined;
    } catch (error: any) {
      console.log(`获取频道关联讨论组失败: ${error.message}`);
      return undefined;
    }
  }

  private async searchInChannelWithLinkedGroup(
    channelInfo: { title: string; handle: string; linkedGroup?: string },
    query: string
  ): Promise<Api.Message[]> {
    const videos: Api.Message[] = [];
    if (!channelInfo.linkedGroup) return [];

    try {
      const linkedGroupEntity = await this.client.getEntity(channelInfo.linkedGroup);
      const groupMessages = await safeGetMessages(this.client, linkedGroupEntity, {
        limit: 100,
        search: query,
      });

      for (const textMsg of groupMessages) {
        if (this.isMessageMatching(textMsg, query) && textMsg.replies) {
          console.log(`找到匹配消息 #${textMsg.id}，正在精确获取其 ${textMsg.replies.replies} 条评论...`);
          const comments = await safeGetMessages(this.client, linkedGroupEntity, {
            limit: 100,
            replyTo: textMsg.id,
          });

          const videoReplies = comments.filter((msg: Api.Message) =>
            msg.video &&
            !(msg.media instanceof Api.MessageMediaWebPage) &&
            !this.isAdContent(msg)
          );

          if (videoReplies.length > 0) {
            console.log(`在评论区找到 ${videoReplies.length} 个视频。`);
            videos.push(...videoReplies);
            return videos;
          }
        }
      }

      if (videos.length === 0) {
        const groupVideoMessages = await safeGetMessages(this.client, linkedGroupEntity, {
          limit: 100,
          search: query,
          filter: new Api.InputMessagesFilterVideo(),
        });

        const pureVideos = groupVideoMessages.filter((v: Api.Message) =>
          v.video &&
          !(v.media instanceof Api.MessageMediaWebPage) &&
          !this.isAdContent(v)
        );

        if (pureVideos.length > 0) {
          videos.push(...pureVideos);
        }
      }
    } catch (linkedGroupError: any) {
      console.error(`访问关联讨论组失败: ${linkedGroupError.message}`);
    }
    return videos;
  }

  public async handle(msg: Api.Message) {
    let fullArgs = msg.message.substring(4).trim();
    const useSpoiler = fullArgs.toLowerCase().includes(" -s");
    const useRandom = fullArgs.toLowerCase().includes(" -r");

    if (useSpoiler) fullArgs = fullArgs.replace(/\s+-s/i, "").trim();
    if (useRandom) fullArgs = fullArgs.replace(/\s+-r/i, "").trim();

    const args = fullArgs.split(/\s+/);
    const subCommand = args[0]?.toLowerCase() as SubCommand;
    const subCommandArgs = args.slice(1).join(" ");

    const adminMsg = await msg.edit({ text: `⚙️ 正在执行命令...` });
    if (!adminMsg) return;

    try {
      switch (subCommand) {
        case SubCommand.Add:
          await this.handleAdd(adminMsg, subCommandArgs);
          break;
        case SubCommand.Delete:
          await this.handleDelete(adminMsg, subCommandArgs);
          break;
        case SubCommand.Default:
          await this.handleDefault(adminMsg, subCommandArgs);
          break;
        case SubCommand.List:
          await this.handleList(adminMsg);
          break;
        case SubCommand.Export:
          await this.handleExport(msg);
          break;
        case SubCommand.Import:
          await this.handleImport(msg);
          break;
        case SubCommand.Kkp:
          await this.handleKkp(msg, useSpoiler);
          break;
        case SubCommand.Ad:
          await this.handleAd(msg, subCommandArgs);
          break;
        default:
          await this.handleSearch(msg, fullArgs, useSpoiler, useRandom);
      }
    } catch (error: any) {
      await adminMsg.edit({ text: `❌ 错误：<br>${error.message}` });
    }
  }

  private async handleAdd(msg: Api.Message, args: string) {
    if (!args) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");
    const channels = args.split("\\");
    let addedCount = 0;

    for (const channelHandle of channels) {
        try {
            const normalizedHandle = channelHandle.trim();
            const entity = await this.client.getEntity(normalizedHandle);

            if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
                await msg.edit({ text: `错误：${normalizedHandle} 不是公开频道、群组或讨论组。` });
                continue;
            }
            if (this.config.channelList.some((c) => c.handle === normalizedHandle)) {
                await msg.edit({ text: `目标 "${entity.title}" 已存在。` });
                continue;
            }

            let linkedGroup: string | undefined;
            if (entity instanceof Api.Channel && !entity.megagroup && entity.broadcast) {
                linkedGroup = await this.discoverLinkedGroup(entity);
            }

            this.config.channelList.push({
                title: entity.title,
                handle: normalizedHandle,
                linkedGroup: linkedGroup,
            });
            if (!this.config.defaultChannel) this.config.defaultChannel = normalizedHandle;
            addedCount++;
        } catch (error: any) {
            await msg.edit({ text: `添加频道 ${channelHandle.trim()} 时出错：${error.message}` });
        }
    }
    await this.saveConfig();
    await msg.edit({ text: `✅ 成功添加 ${addedCount} 个频道。` });
  }

  private async handleDelete(msg: Api.Message, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so del &lt;频道链接|序号&gt; [...] 或 ${mainPrefix}so del all。`);
    if (args.toLowerCase().trim() === "all") {
        const count = this.config.channelList.length;
        this.config.channelList = [];
        this.config.defaultChannel = null;
        await this.saveConfig();
        await msg.edit({ text: `✅ 已清空所有 ${count} 个频道。` });
        return;
    }

    const inputs = args.split(/[\s\\]+/).filter(Boolean);
    const handlesToRemove = new Set<string>();
    const removedTitles: string[] = [];
    
    const currentList = [...this.config.channelList];

    for (const input of inputs) {
        const index = parseInt(input, 10);
        if (!isNaN(index) && index > 0 && index <= currentList.length) {
            const handle = currentList[index - 1].handle;
            handlesToRemove.add(handle);
        } else {
            handlesToRemove.add(input);
        }
    }
    
    if (handlesToRemove.size === 0) {
        await msg.edit({ text: `❓ 未提供有效的频道链接或序号。` });
        return;
    }
    
    const originalLength = this.config.channelList.length;
    
    this.config.channelList = this.config.channelList.filter(channel => {
        if (handlesToRemove.has(channel.handle)) {
            removedTitles.push(channel.title);
            return false;
        }
        return true;
    });
    
    const removedCount = originalLength - this.config.channelList.length;

    if (removedCount > 0) {
        if (this.config.defaultChannel && handlesToRemove.has(this.config.defaultChannel)) {
            this.config.defaultChannel = this.config.channelList.length > 0 ? this.config.channelList[0].handle : null;
        }
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功移除 ${removedCount} 个频道:<br>- ${removedTitles.join('<br>- ')}` });
    } else {
        await msg.edit({ text: `❓ 在列表中未找到指定的频道或序号。` });
    }
  }

  private async handleDefault(msg: Api.Message, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so default &lt;频道链接&gt; 或 ${mainPrefix}so default d。`);
    if (args === "d") {
        this.config.defaultChannel = null;
        await this.saveConfig();
        await msg.edit({ text: `✅ 默认频道已移除。` });
        return;
    }
    const normalizedHandle = args.trim();
    if (!this.config.channelList.some((c) => c.handle === normalizedHandle)) {
        throw new Error(`请先使用 \`${mainPrefix}so add\` 添加此频道。`);
    }
    this.config.defaultChannel = normalizedHandle;
    await this.saveConfig();
    await msg.edit({ text: `✅ 已将 "${normalizedHandle}" 设为默认频道。` });
  }

  private async handleList(msg: Api.Message) {
    if (this.config.channelList.length === 0) {
      await msg.edit({ text: "没有添加任何搜索频道。" });
      return;
    }
    let listText = "**当前搜索频道列表:**<br><br>";
    this.config.channelList.forEach((channel, index) => {
      const isDefault = channel.handle === this.config.defaultChannel ? " (默认)" : "";
      listText += `${index + 1}. ${channel.title}${isDefault}<br>`;
    });
    await msg.edit({ text: listText });
  }

  private async handleExport(msg: Api.Message) {
    if (this.config.channelList.length === 0) {
        await msg.edit({ text: "没有可导出的频道。" });
        return;
    }
    const backupContent = this.config.channelList.map((c) => c.handle).join("<br>");
    const backupFilePath = path.join(process.cwd(), "temp", "so_channels_backup.txt");
    await fs.mkdir(path.dirname(backupFilePath), { recursive: true });
    await fs.writeFile(backupFilePath, backupContent);
    await this.client.sendFile(msg.chatId!, { file: backupFilePath, caption: `✅ 您的频道源已导出。`, replyTo: msg });
    await fs.unlink(backupFilePath);
  }

  private async handleImport(msg: Api.Message) {
    const replied = await safeGetReplyMessage(msg);
    if (!replied || !replied.document) throw new Error("❌ 请回复备份文件。");
    
    const buffer = await this.client.downloadMedia(replied.media!);
    if (!buffer) throw new Error("下载文件失败。");

    const handles = buffer.toString().split("\n").map((h: string) => h.trim()).filter(Boolean);
    if (handles.length === 0) throw new Error("备份文件无效。");

    await msg.edit({ text: `⚙️ 正在导入 ${handles.length} 个源...` });
    this.config.channelList = [];
    this.config.defaultChannel = null;
    await this.handleAdd(msg, handles.join("\\"));
  }

  private async handleAd(msg: Api.Message, args: string) {
    const parts = args.split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();
    const keywords = parts.slice(1);

    switch (subCmd) {
      case "add":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        this.config.adFilters.push(...keywords);
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功添加 ${keywords.length} 个广告过滤词。` });
        break;
      case "del":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        const initialLength = this.config.adFilters.length;
        this.config.adFilters = this.config.adFilters.filter(k => !keywords.includes(k));
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功删除 ${initialLength - this.config.adFilters.length} 个广告过滤词。` });
        break;
      case "list":
        if (this.config.adFilters.length === 0) {
          await msg.edit({ text: "当前没有广告过滤词。" });
        } else {
          await msg.edit({ text: `**当前广告过滤词:**<br><br>${this.config.adFilters.join(", ")}` });
        }
        break;
      default:
        throw new Error(`用法: ${mainPrefix}so ad &lt;add|del|list&gt; [关键词]`);
    }
  }

  private async handleKkp(msg: Api.Message, useSpoiler: boolean) {
    await this.findAndSendVideo(msg, null, useSpoiler, true, "kkp");
  }

  private async handleSearch(msg: Api.Message, query: string, useSpoiler: boolean, useRandom: boolean) {
    if (!query) throw new Error("请输入搜索关键词。");
    await this.findAndSendVideo(msg, query, useSpoiler, useRandom, "search");
  }

  private async findAndSendVideo(
    msg: Api.Message,
    query: string | null,
    useSpoiler: boolean,
    useRandom: boolean,
    type: "kkp" | "search"
  ) {
    if (this.config.channelList.length === 0)
      throw new Error(`请至少使用 \`${mainPrefix}so add\` 添加一个搜索频道。`);

    const initialMessage = type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...";
    await msg.edit({ text: initialMessage });

    const searchOrder = [...new Set([this.config.defaultChannel, ...this.config.channelList.map((c) => c.handle)].filter(Boolean) as string[])];
    
    let validVideos: Api.Message[] = [];
    const processedGroupIds = new Set<string>();

    for (const [index, channelHandle] of searchOrder.entries()) {
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 750));
      }

      const channelInfo = this.config.channelList.find((c) => c.handle === channelHandle);
      if (!channelInfo) continue;
      
      let videosInCurrentChannel: Api.Message[] = [];

      try {
        await msg.edit({ text: `- 正在搜索... (源: ${index + 1}/${searchOrder.length})` });
        const entity = await this.client.getEntity(channelInfo.handle);

        if (type === "search" && query) {
          if (channelInfo.linkedGroup) {
            const linkedVideos = await this.searchInChannelWithLinkedGroup(channelInfo, query);
            if (linkedVideos.length > 0) videosInCurrentChannel.push(...linkedVideos);
          }

          const allQueryMessages = await safeGetMessages(this.client, entity, { limit: 200, search: query });

          for (const foundMsg of allQueryMessages) {
            if (this.isMessageMatching(foundMsg, query)) {
              if (foundMsg.groupedId) {
                const groupIdStr = foundMsg.groupedId.toString();
                if (processedGroupIds.has(groupIdStr)) continue;

                const surroundingMessages = await safeGetMessages(this.client, entity, {
                    limit: 20,
                    offsetId: foundMsg.id + 10,
                });
                
                const groupedId = foundMsg.groupedId;
                if (!groupedId) continue;
                const albumMessages = surroundingMessages.filter((m: Api.Message) => m.groupedId?.equals(groupedId));
                const videosInAlbum = albumMessages.filter((m: Api.Message) => m.video && !this.isAdContent(m));

                if (videosInAlbum.length > 0) {
                  videosInCurrentChannel.push(...videosInAlbum);
                  processedGroupIds.add(groupIdStr);
                }
              } else if (foundMsg.video && !this.isAdContent(foundMsg)) {
                videosInCurrentChannel.push(foundMsg);
              }
            }
          }
        } else if (type === "kkp") { 
          const isMegagroup = entity instanceof Api.Channel && entity.megagroup === true;
          const messages = await safeGetMessages(this.client, entity, {
            limit: isMegagroup ? 200 : 100,
            filter: new Api.InputMessagesFilterVideo(),
          });

          const filteredVideos = messages.filter((v: Api.Message) => {
            const isPureVideo = v.video && !(v.media instanceof Api.MessageMediaWebPage);
            if (!isPureVideo || this.isAdContent(v)) return false;

            const durationAttr = v.video?.attributes.find((attr: any) => attr instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
            return durationAttr && durationAttr.duration >= 20 && durationAttr.duration <= 180;
          });
          videosInCurrentChannel.push(...filteredVideos);
        }
        
        if (videosInCurrentChannel.length > 0) {
          validVideos.push(...videosInCurrentChannel);
          if (type === "search" && !useRandom) {
              console.log(`在频道 "${channelInfo.title}" 中找到结果，精确模式下停止搜索。`);
              break;
          }
        }

      } catch (error: any) {
        if (error.message.includes("Could not find the input entity")) {
            console.error(`无法找到频道 ${channelInfo.title}，已自动移除。`);
            this.config.channelList = this.config.channelList.filter(c => c.handle !== channelHandle);
            if(this.config.defaultChannel === channelHandle) this.config.defaultChannel = null;
            await this.saveConfig();
        } else {
            console.error(`在频道 "${channelInfo.title}" 搜索失败: ${error.message}`);
        }
        continue;
      }
    }

    if (validVideos.length > 0) {
        validVideos = Array.from(new Map(validVideos.map(v => [v.id, v])).values());
    }

    if (validVideos.length === 0) {
      await msg.edit({ text: type === "kkp" ? "🤷‍♂️ 未找到合适的视频。" : "❌ 在任何频道中均未找到匹配结果。" });
      return;
    }

    let selectedVideo: Api.Message;

    if (useRandom || type === "kkp") {
      console.log(`随机模式开启，从 ${validVideos.length} 个视频中选择...`);
      selectedVideo = this.selectRandomVideo(validVideos);
    } else {
      console.log(`精确模式，从 ${validVideos.length} 个视频中按相关性选择...`);
      if (validVideos.length > 1) {
          const queryNormalized = this.normalizeSearchTerm(query || "");
          const getScore = (video: Api.Message): number => {
              let score = 0;
              const fileNameAttr = video.video?.attributes.find((attr: any): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename);
              if (fileNameAttr?.fileName) {
                  const normalizedFileName = this.normalizeSearchTerm(fileNameAttr.fileName);
                  if (normalizedFileName.includes(queryNormalized)) score += 100;
              }
              if (video.message) {
                  const normalizedMessage = this.normalizeSearchTerm(video.message);
                  if (normalizedMessage.includes(queryNormalized)) score += 50;
              }
              return score;
          };

          validVideos.sort((a, b) => {
              const scoreA = getScore(a);
              const scoreB = getScore(b);
              if (scoreB !== scoreA) return scoreB - scoreA;
              
              const durationA = a.video?.attributes.find((attr: any): attr is Api.DocumentAttributeVideo => attr instanceof Api.DocumentAttributeVideo)?.duration || 0;
              const durationB = b.video?.attributes.find((attr: any): attr is Api.DocumentAttributeVideo => attr instanceof Api.DocumentAttributeVideo)?.duration || 0;
              return durationB - durationA;
          });
      }
      selectedVideo = validVideos[0];
    }

    await msg.edit({ text: `✅ 已找到结果，准备发送...` });
    
    const originalMsg = msg;
    await this.sendVideo(originalMsg, selectedVideo, useSpoiler, query);
    
    if (!useSpoiler && originalMsg.out) {
      try {
        await originalMsg.delete();
      } catch (e) {
        console.warn("删除原始消息失败，可能已被删除");
      }
    }
  }

  private async sendVideo(originalMsg: Api.Message, video: Api.Message, useSpoiler: boolean, caption?: string | null) {
    if (useSpoiler) {
      await this.downloadAndUploadVideo(originalMsg, video, true, caption);
    } else {
      try {
        await this.client.forwardMessages(originalMsg.peerId, { messages: [video.id], fromPeer: video.peerId });
      } catch (forwardError: any) {
        console.log(`转发失败，自动转为下载上传: ${forwardError.message}`);
        await this.downloadAndUploadVideo(originalMsg, video, false, caption);
      }
    }
  }

  private async downloadAndUploadVideo(originalMsg: Api.Message, video: Api.Message, spoiler: boolean = false, caption?: string | null): Promise<void> {
    const tempDir = path.join(process.cwd(), "temp");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `video_${Date.now()}.mp4`);
    const statusMsg = await this.client.sendMessage(originalMsg.chatId!, { message: `🔥 正在下载视频...`, replyTo: originalMsg.id });

    try {
      await this.client.downloadMedia(video.media!, { outputFile: tempFilePath });
      await statusMsg.edit({ text: `✅ 下载完成，正在上传...` });

      if (!video.video) throw new Error("消息不包含有效的视频媒体。");
      const fileStat = await fs.stat(tempFilePath);
      const fileToUpload = new CustomFile(path.basename(tempFilePath), fileStat.size, tempFilePath);
      
      const videoAttr = video.video.attributes.find((attr: any): attr is Api.DocumentAttributeVideo => attr instanceof Api.DocumentAttributeVideo);

      await this.client.sendFile(originalMsg.peerId, {
          file: fileToUpload,
          caption: caption || video.message || "",
          forceDocument: false,
          spoiler: spoiler,
          attributes: [
              new Api.DocumentAttributeVideo({
                  duration: videoAttr?.duration || 0,
                  w: videoAttr?.w || 0,
                  h: videoAttr?.h || 0,
                  supportsStreaming: true,
              }),
              new Api.DocumentAttributeFilename({ fileName: fileToUpload.name }),
          ],
          replyTo: originalMsg.id
      });
      await statusMsg.delete();
      if (originalMsg.out) await originalMsg.delete();
    } catch (error: any) {
      console.error("下载上传视频时出错:", error);
      await statusMsg.edit({ text: `❌ 发送视频失败: ${error.message}` });
    } finally {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn("清理临时文件失败:", cleanupError);
      }
    }
  }

  private isMessageMatching(message: Api.Message, query: string): boolean {
    const normalizedQuery = this.normalizeSearchTerm(query);
    const textSources = [message.text, message.message];
    const fileNameAttr = message.video?.attributes.find((attr: any): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename);
    if (fileNameAttr?.fileName) textSources.push(fileNameAttr.fileName);

    for (const source of textSources) {
      if (source) {
        const normalizedText = this.normalizeSearchTerm(source);
        if (this.fuzzyMatch(normalizedText, normalizedQuery)) return true;
      }
    }
    return false;
  }

  private normalizeSearchTerm(text: string): string {
    return text.toLowerCase().replace(/[-_\s\.\|\\\/#]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private fuzzyMatch(text: string, query: string): boolean {
    if (text.includes(query)) return true;
    const queryParts = query.split(' ').filter(part => part.length > 0);
    const textParts = text.split(' ');

    if (queryParts.length === 1 && /[a-z]+\s*\d+/i.test(query)) {
      if (text.replace(/\s+/g, '').includes(query.replace(/\s+/g, ''))) return true;
    }

    return queryParts.every(queryPart => textParts.some(textPart => textPart.includes(queryPart)));
  }

  private isAdContent(message: Api.Message): boolean {
    const text = (message.text || message.message || "").toLowerCase();
    const fileNameAttr = message.video?.attributes.find((attr: any): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename);
    const fileName = (fileNameAttr?.fileName || "").toLowerCase();
    return this.config.adFilters.some(filter => text.includes(filter) || fileName.includes(filter));
  }

  private selectRandomVideo(videos: Api.Message[]): Api.Message {
    return videos[Math.floor(Math.random() * videos.length)];
  }
}

const so = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) return;

  const service = new SearchService(client);
  await service.initialize();
  await service.handle(msg);
};

class ChannelSearchPlugin extends Plugin {
    cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }


  description: string = `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: ${mainPrefix}so &lt;关键词&gt; （不限制大小和时长）
- 随机速览: ${mainPrefix}so kkp （随机选择20秒-3分钟的视频）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 随机模式: -r (从匹配结果中随机选择)

频道管理:
- 添加频道: .so add &lt;频道链接&gt; (使用 \\ 分隔)
- 删除频道: ${mainPrefix}so del &lt;频道链接|序号&gt; [...] 或 ${mainPrefix}so del all (删除所有)
- 设置默认: ${mainPrefix}so default &lt;频道链接&gt; 或 ${mainPrefix}so default d (移除默认)
- 列出频道: ${mainPrefix}so list
- 导出配置: ${mainPrefix}so export
- 导入配置: ${mainPrefix}so import (回复备份文件)

广告过滤:
- 添加关键词: ${mainPrefix}so ad add &lt;关键词1&gt; &lt;关键词2&gt; ...
- 删除关键词: ${mainPrefix}so ad del &lt;关键词1&gt; &lt;关键词2&gt; ...
- 查看关键词: ${mainPrefix}so ad list`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    so,
    search: so,
  };
}

export default new ChannelSearchPlugin();
