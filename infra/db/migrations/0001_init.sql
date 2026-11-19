-- 0001_init: schema app, tables, constraints, indexes, append-only triggers.
-- Source: docs/design/A-01-frontend-backend.md section 3.2 (copied verbatim, comments kept).
-- Runs as fb_owner via infra/db/init/00-roles.sh; recorded in app.schema_migrations. Forward-only.
-- D-54: agent.message.messageJson and M-2 processText live inside events.payload (jsonb); NO separate columns (A-01 3.2 requires none).
-- Session consumption-tracking columns match CONTRACT-v1 M-8 and A-01 6.4 (last_user_seq, consumed_up_to_seq,
-- open_run_id, oldest_unconsumed_at, last_agent_event_at): all present below.
CREATE SCHEMA IF NOT EXISTS app;

-- ID 格式：前缀 + 26 位随机 Crockford base32（O-7）。例如 'q_7K3F9QX2M8T4H6J1R5N0V2C9BD'
-- users / sessions 用 uuid（只在系统内部使用，不进入 LLM 上下文）

-- 用户（D-08：只填用户名；第一次登录时自动注册，D-30）
CREATE TABLE app.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,                       -- 原样展示
  username_norm text NOT NULL UNIQUE,                -- NFKC + trim + lower；先规范化再校验长度（S-5）
  locale        text NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh','en')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(username_norm) BETWEEN 1 AND 32)
);

-- 会话（对话）。只有 gateway 能写。下面的"消费跟踪"列是 B-3 的核心（§6.4）
CREATE TABLE app.sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users(id),
  title               text,                          -- 取第一条用户消息的前 40 个字符，确定性生成，不用 LLM
  locale              text NOT NULL CHECK (locale IN ('zh','en')),
  last_seq            bigint NOT NULL DEFAULT 0,     -- 分配 seq 时用的计数器
  -- 消费跟踪（§6.4）。列名和 A-02 v0.4 §3.1 / §16.3 C-4 一致
  last_user_seq       bigint NOT NULL DEFAULT 0,     -- 最新一条 user.message 的 seq
  last_user_at        timestamptz,                   -- 最新一条 user.message 的落库时间
  oldest_unconsumed_at timestamptz,                  -- 最早一条"还没被消费"的 user.message 的落库时间；没有未消费的输入时为 NULL（§6.4）
  consumed_up_to_seq  bigint NOT NULL DEFAULT 0,     -- 所有 agent.run_started.consumedUpToSeq 的最大值
  open_run_id         text,                          -- 当前未结束的运行；run_started / resumed 时设置，completed / failed 时清空
  last_agent_event_at timestamptz,                   -- 最近一次 harness 写入事件的时间
  last_run_outcome    text CHECK (last_run_outcome IN ('completed','failed')),
  max_fence_seen      bigint NOT NULL DEFAULT 0,     -- emit 成功时见过的最大 fence（D-34）
  -- 只用来显示，由上面几列推导（§6.4）；任何逻辑都不能读它来做判断
  status              text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','queued','running','error')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_updated ON app.sessions (user_id, updated_at DESC, id DESC);
-- sweeper 用：有未消费输入，或者有未结束运行的会话（§7.4）
CREATE INDEX sessions_sweep ON app.sessions (id)
  WHERE last_user_seq > consumed_up_to_seq OR open_run_id IS NOT NULL;

-- 事件日志：只追加（H-05）。只有 gateway 能写
CREATE TABLE app.events (
  session_id      uuid   NOT NULL REFERENCES app.sessions(id),
  seq             bigint NOT NULL,                   -- 每个会话从 1 开始，连续无空洞
  id              uuid   NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  type            text   NOT NULL,                   -- 取值见 §6.3 和 A-02 §2
  actor           text   NOT NULL CHECK (actor IN ('user','agent','system')),
  ts              timestamptz NOT NULL DEFAULT now(),
  trace_id        text   NOT NULL,
  idempotency_key text   NOT NULL,                   -- 每个事件都必须有（格式见 §6.3、A-02 §3.7）
  schema_version  smallint NOT NULL DEFAULT 1,       -- 保留（O-5 不采纳，理由见 §18.3）
  payload         jsonb  NOT NULL,                   -- 键的顺序不保证；需要原样字节的内容放在 payload 里的字符串字段中（D-54：agent.message.messageJson，§6.1）
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, idempotency_key)
);
-- v0.3 的 CHECK (pg_column_size(payload) <= 65536) 已删除（S-14：对 TOAST 压缩后的值不可靠）；大小由 gateway 在写入前检查（§5.1）
CREATE INDEX events_booking_confirmed ON app.events (session_id, idempotency_key)
  WHERE type = 'booking.confirmed';
CREATE FUNCTION app.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON app.events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON app.events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
-- 触发器防的是运行时角色的误操作。owner 可以 DISABLE TRIGGER，所以真正的保证是"运行时没有任何服务使用 owner"（H-05，I-14）

-- 报价：不可变（D-10：不过期）。只有 hands 能写
CREATE TABLE app.quotes (
  id            text PRIMARY KEY CHECK (id ~ '^q_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id       uuid NOT NULL REFERENCES app.users(id),     -- 来自 hands token，不来自 LLM
  session_id    uuid NOT NULL REFERENCES app.sessions(id),  -- 同上
  from_city     text NOT NULL,                              -- locations.db 的 city_name 原文
  to_city       text NOT NULL,
  data_sha256   text NOT NULL,                              -- locations.db 的 sha256
  payload       jsonb NOT NULL,                             -- A-02 §7.2 的 Quote
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_session ON app.quotes (session_id, created_at);
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON app.quotes
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 报价出示记录（A-02 §7.3 offer_booking）：每出示一次插入一行。只有 hands 能写
CREATE TABLE app.quote_offers (
  quote_id     text NOT NULL REFERENCES app.quotes(id),
  session_id   uuid NOT NULL REFERENCES app.sessions(id),
  tool_call_id text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, tool_call_id)
);
CREATE INDEX quote_offers_session ON app.quote_offers (session_id, quote_id);
CREATE TRIGGER quote_offers_immutable BEFORE UPDATE OR DELETE ON app.quote_offers
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 工具调用的幂等缓存（A-02 §5.1）。只有 hands 能写
-- 主键里加上 run_id（S-15）：不假设厂商的 toolCallId 在整个会话里跨运行唯一。崩溃恢复后 runId 不变（A-02 §3.6），所以重放仍然能命中
CREATE TABLE app.tool_calls (
  session_id   uuid NOT NULL REFERENCES app.sessions(id),
  run_id       text NOT NULL,
  tool_call_id text NOT NULL,
  name         text NOT NULL,
  input_sha256 text NOT NULL,                               -- sha256(canonicalJson(input))（I-5）
  response     jsonb NOT NULL,                              -- 第一次的完整响应 { ok, llmText, data | error }
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, tool_call_id)
);
CREATE TRIGGER tool_calls_immutable BEFORE UPDATE OR DELETE ON app.tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 机票。只有 booking 能写。v0.3 的 quote_redemptions 已删除（O-1）：tickets.quote_id UNIQUE 已经保证每个报价只能出一张票
CREATE TABLE app.tickets (
  id                text PRIMARY KEY CHECK (id ~ '^t_[0-9A-HJKMNP-TV-Z]{26}$'),
  ticket_no         text NOT NULL UNIQUE,                   -- 'OA-' + id 主体的最后 8 位（O-5）
  user_id           uuid NOT NULL REFERENCES app.users(id),
  session_id        uuid NOT NULL REFERENCES app.sessions(id),  -- 等于 quotes.session_id
  quote_id          text NOT NULL UNIQUE REFERENCES app.quotes(id),
  from_city         text NOT NULL,                          -- city_name 原文
  to_city           text NOT NULL,
  itinerary         jsonb NOT NULL,                         -- 报价 payload 的完整快照
  total_distance_km double precision NOT NULL,              -- 未舍入的原始值（D-09）
  price_cents       integer NOT NULL CHECK (price_cents >= 0),  -- 成交价 = 报价的 priceCents（不重新计算）
  status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued')),
  booked_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_user ON app.tickets (user_id, booked_at DESC, id DESC);
CREATE TRIGGER tickets_immutable BEFORE UPDATE OR DELETE ON app.tickets
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();       -- 退票不在范围内；以后要做就改成插入 ticket_events

-- 长期记忆（A-02 §9；D-38 只存枚举偏好；D-42 去掉了 avoid_transfer_city）。只有 hands 能写，只能插入
-- 规则："每个 (user_id, key) 取最新一行"。value 为 NULL 表示 forget_preference（墓碑）
CREATE TABLE app.user_memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES app.users(id),
  key               text NOT NULL CHECK (key IN ('home_city','preferred_language')),   -- S-6
  value             text,                                   -- city_name 原文，或语言枚举；NULL = 已忘记
  source_session_id uuid NOT NULL REFERENCES app.sessions(id),
  source_seq        bigint NOT NULL,                        -- 触发这条记忆的 user.message 的 seq（来自 execute 信封的 inputSeq，I-6）
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)                                      -- 给 memory_deletions 的复合外键用
);
CREATE INDEX user_memories_latest ON app.user_memories (user_id, key, created_at DESC, id DESC);
CREATE TRIGGER user_memories_immutable BEFORE UPDATE OR DELETE ON app.user_memories
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 记忆删除（用户在画像面板里操作）。只有 gateway 能写，只能插入
CREATE TABLE app.memory_deletions (
  memory_id  uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (memory_id, user_id) REFERENCES app.user_memories (id, user_id)   -- S-6：只能删自己的记忆
);
