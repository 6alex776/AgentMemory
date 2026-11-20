/**
 * 评测用的两组中文用例。内容取自毕设本身的真实语境（湖仓看板 + AgentMemory），
 * 不是从 LongMemEval 翻译过来的——论文里说明这一点：数据是自己造的，规模小但可控。
 *
 * A 组：更新语义。同一个 topicKey 先写旧值再写新值，检查旧值是否被替换、注入里是否只剩新值。
 * B 组：跨会话指代。新会话里用一句自然的问题去捞一条之前存下的记忆，检查是否被注入/检索到。
 */

export const A_CASES = [
  { slot: 'tech.datastore', old: '数据存储用 MySQL 8，订单表按月分表', new: '数据存储改用 PostgreSQL 16，分区表替代分表', question: '我们的数据存在哪个数据库？' },
  { slot: 'tech.queue', old: '消息队列用 RabbitMQ，所有事件都进一个直连交换机', new: '消息队列改用 Kafka，按 topic 分区', question: '消息队列现在用的是什么？' },
  { slot: 'tech.scheduler', old: '离线段用 Airflow 1.10 的 CeleryExecutor 调度', new: '离线段改用 Airflow 2.9 的 KubernetesExecutor 调度', question: '离线任务现在怎么调度？' },
  { slot: 'tech.api', old: '后端 API 用 Flask + SQLAlchemy', new: '后端 API 改成 FastAPI + SQLModel', question: '后端接口用什么框架写的？' },
  { slot: 'tech.frontend', old: '前端用 Vue 2 + Element UI', new: '前端换成 Vue 3 + Naive UI', question: '看板的前端技术栈是什么？' },
  { slot: 'ops.deploy', old: '部署方式是 Docker Compose 单机部署', new: '部署方式改成 K3s 单集群 + Helm', question: '现在是怎么部署的？' },
  { slot: 'tech.auth', old: '鉴权用 Session + 服务端 Cookie', new: '鉴权改成 JWT + 刷新令牌', question: '登录鉴权怎么做的？' },
  { slot: 'tech.cache', old: '缓存用 Redis 5 的字符串结构，TTL 统一 10 分钟', new: '缓存改成 Redis 7 的 Hash 结构，TTL 按数据源分档', question: '缓存是怎么配置的？' },
  { slot: 'ops.log', old: '日志直接 print 到容器标准输出，靠 docker logs 看', new: '日志统一走 structlog 打 JSON，再由 Loki 收集', question: '日志是怎么收集的？' },
  { slot: 'ops.monitor', old: '监控只有 Prometheus + Grafana 的基础面板', new: '监控补上 OpenTelemetry 链路追踪与告警规则', question: '监控体系包含哪些东西？' },
  { slot: 'ops.ci', old: 'CI 用 Jenkins Freestyle 任务，手动点构建', new: 'CI 迁到 GitHub Actions，PR 触发流水线', question: 'CI 在哪里跑？' },
  { slot: 'tech.package', old: 'Python 依赖用 requirements.txt 手工维护', new: 'Python 依赖改用 uv + pyproject.toml 锁定', question: '依赖是怎么管理的？' },
  { slot: 'tech.orm', old: '数据库访问用原生 SQL 拼字符串', new: '数据库访问改成 SQLModel 的声明式模型', question: '数据库访问层用的什么？' },
  { slot: 'tech.test', old: '测试只写了几个手工脚本', new: '测试改成 pytest + 覆盖率门禁 70%', question: '测试是怎么跑的？' },
  { slot: 'ops.registry', old: '镜像直接推到 Docker Hub 公共仓库', new: '镜像改推私有 Harbor 仓库并开启扫描', question: '镜像放在哪个仓库？' },
  { slot: 'tech.objectstore', old: '对象存储用本地磁盘挂载目录', new: '对象存储改用 MinIO 的 S3 兼容桶', question: '原始文件存在哪里？' },
  { slot: 'tech.chart', old: '图表用 ECharts 4 的默认主题', new: '图表换成 ECharts 5 的 dark 主题 + 自定义色板', question: '看板用的图表库是哪个？' },
  { slot: 'tech.llm', old: '模型调用直连 OpenAI gpt-4o', new: '模型调用改走公司网关的 deepseek-chat', question: '模型是从哪里调用的？' },
  { slot: 'tech.vector', old: '向量检索用 FAISS 本地索引', new: '向量检索改成 pgvector 扩展', question: '向量检索用什么实现？' },
  { slot: 'ops.notify', old: '告警通过邮件发给值班邮箱', new: '告警改成企业微信机器人推送', question: '告警是怎么通知的？' },
]

/** 与 B 组问题都无关的记忆，用来当干扰项。 */
export const DISTRACTORS = [
  '提交信息用中文写，一句话说清改动',
  '每周三晚上开组会，会前把问题发群里',
  '代码风格统一用 prettier 默认配置',
  '实验记录写在 docs/notes 下，按日期命名',
  '服务器登录用密钥，不用密码',
  '画图配色避开红绿对比，照顾色弱',
  '答辩 PPT 控制在 15 页以内',
  '参考文献用 GB/T 7714 格式',
]

/** target 一条 + 4 条干扰项。 */
export const B_CASES = [
  { question: '行情事件那条链路是怎么串起来的？', target: '实时链路：Kafka 收行情事件 → Flink 清洗计算 → Iceberg 落湖' },
  { question: '看板的刷新频率是多少？', target: '看板每 30 秒轮询一次近实时接口' },
  { question: '毕设中期检查要交什么？', target: '中期检查要交 12 页进展报告和一份可运行的原型' },
  { question: '样本行情数据是怎么模拟出来的？', target: '用 FAKEPACA 协议模拟新浪行情推送，价格走随机游走' },
  { question: '湖仓的分层是怎么设计的？', target: '数仓分 ODS/DWD/DWS/ADS 四层，DWS 按主题域聚合' },
  { question: '写报告的时候用什么排版？', target: '报告用 LaTeX 模板排版，图表统一矢量导出' },
  { question: '数据量大概多大？', target: '每天约 1200 万条行情快照，压缩后 3GB 左右' },
  { question: '为什么不用 Flink 做离线？', target: '离线和实时分开：Flink 只做实时，离线批处理交给 Spark' },
  { question: '导师建议改什么？', target: '导师建议把评测部分从人工打分改成可复现的脚本' },
  { question: '演示环境部署在什么机器上？', target: '演示环境部署在一台 16 核 32G 的云主机上' },
  { question: '表结构变更怎么管理？', target: '表结构用 Alembic 迁移文件管理，禁止手工 DDL' },
  { question: '数据质量怎么保证？', target: '关键字段做非空与范围校验，异常记录进 quarantine 表' },
  { question: '看板有哪些页面？', target: '看板有总览、行情、持仓、告警四个页面' },
  { question: '实时计算的窗口多大？', target: '实时计算用 1 分钟滚动窗口 + 5 分钟滑动窗口' },
  { question: '冷数据放哪？', target: '超过 90 天的冷数据归档到 MinIO 的冷桶' },
  { question: '压测结论是什么？', target: '压测到 8000 QPS 时 P99 延迟 120ms，瓶颈在 Iceberg 写入' },
  { question: '权限模型怎么设计的？', target: '权限分管理员、分析师、只读三种角色，按项目隔离' },
  { question: '记忆整合为什么要分两步？', target: '记忆整合分两步：模型只负责分组，合并由代码按规则判断再人工确认' },
  { question: '同一个槽位再写入会怎样？', target: '同一 topicKey 写入新值会把旧值标为 superseded，版本链保留在 memory_version' },
  { question: '注入预算怎么分的？', target: '注入预算 400/800/600：身份块 400、项目块 800、检索块 600 字符' },
]
