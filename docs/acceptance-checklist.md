# 0.5.0 组织首发验收清单

没有完成本清单，不得确认组织仓库迁移完成。

## 自动门禁

- [ ] Ubuntu CI 通过。
- [ ] macOS CI 通过。
- [ ] NPM tarball 白名单通过。
- [ ] tarball 可安装到当次最新版 DSH `web` profile。
- [ ] DSH Web 启动冒烟通过。
- [ ] `THIRD_PARTY_NOTICES.md` 已记录精确上游 commit。
- [ ] Secret 扫描没有发现凭据、内部地址或测试账号数据。
- [ ] NPM 发布不依赖长期 Token，Trusted Publisher OIDC 生效。
- [ ] NPM provenance 指向 `DingTalk-Real-AI/dsh-dingtalk` 的准确提交与 workflow。
- [ ] `latest` 指向 `0.5.0`，个人仓库时期遗留的 `beta` dist-tag 已移除。

## 真实链路

- [ ] 全新环境执行 `npx @dingtalk-real-ai/dsh-dingtalk@latest setup`。
- [ ] 扫码创建应用成功。
- [ ] 手动凭据备用流程成功。
- [ ] `dsh web` 启动并建立 Stream 连接。
- [ ] 同一 `dsh web` 至少同时连接两个机器人，并分别完成消息收发。
- [ ] 两个机器人的管理员绑定、会话映射和去重状态相互隔离。
- [ ] 停止或配置错误其中一个机器人，不影响另一个机器人继续收发消息。
- [ ] 私聊 `/bind` 成功，口令随后失效。
- [ ] 私聊文本与 AI Card 流式回复正常。
- [ ] 群聊白名单和未授权拒绝行为正确。
- [ ] DWS 开启、关闭、未安装和未登录状态提示正确。
- [ ] 支持图片的模型可以接收图片。
- [ ] 不支持图片或元数据未知时安全降级。
- [ ] 重复执行 setup 能新增机器人或修改选中机器人，且不覆盖其他机器人与功能设置。
- [ ] `doctor` 按机器人输出，且每个机器人的结论与真实状态一致。

验收记录只保存版本、commit、时间、平台和结果，不保存二维码、Secret 或聊天内容。
