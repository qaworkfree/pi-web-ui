/**
 * db-client 插件服务端 —— 数据库连接管理/浏览后端（参照 vscode-database-client 的核心体验）。
 *
 * 依赖驱动不随包分发：首次激活自动 npm 一次性安装
 * mysql2 / pg / better-sqlite3 / mssql / mongodb / ioredis 到插件目录（同 ssh/webmail 模式）。
 *
 * 职责：
 * - 连接配置 CRUD（存 conn.dir/db-connections.json，明文本机；回显脱敏只报 hasPass）
 * - 连接池：connId → 适配器实例；事件定向推给创建者 socket
 * - 统一适配器接口（按数据库类型分流）：
 *     listDatabases() / listTables(db) / describeTable(db,table)
 *     selectPage(db,table,{offset,limit,orderBy,dir,filter}) / query(db,sql)
 *   SQL 系（mysql/postgres/sqlserver/sqlite）走 SQL；mongodb 走 find+JSON 过滤；
 *   redis 单独一组动作（scan/key/del/原始命令）。
 *
 * 协议：上行 { action, reqId?, ... }；下行两类——
 *   响应 { res: true, reqId, ok, ... }（reqId 匹配）
 *   事件  { event: "conn_closed", ... }（sendTo 创建者）
 *   广播  { kind: "state", state }（连接列表 / 运行中连接 / 依赖状态，凭据脱敏）
 */

import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile as rf, writeFile as wf } from "node:fs/promises";

const CONFIG_FILE = "db-connections.json";
const DEPS = ["mysql2@^3", "pg@^8", "mssql@^12", "mongodb@^7", "ioredis@^6"];
const MAX_CONNS = 32; // 连接配置上限
const MAX_RUNTIME = 8; // 同时打开的连接数
const OP_TIMEOUT_MS = 30_000; // 单次查询超时
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PAGE_ROWS = 500;
const MAX_QUERY_ROWS = 1000;
const MAX_CELL_LEN = 4000; // 单元格序列化截断

export const DB_TYPES = {
	mysql: { label: "MySQL", port: 3306 },
	postgres: { label: "PostgreSQL", port: 5432 },
	sqlite: { label: "SQLite", port: 0 },
	sqlserver: { label: "SQL Server", port: 1433 },
	mongodb: { label: "MongoDB", port: 27017 },
	redis: { label: "Redis", port: 6379 },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, rej) => setTimeout(() => rej(new Error(`${label ?? "操作"}超时（${ms / 1000}s）`)), ms)),
	]);
}

/** 标识符方言引用（防注入：标识符一律过引号函数） */
function qMysql(s) { return "`" + String(s).replace(/`/g, "``") + "`"; }
function qPg(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
function qMssql(s) { return "[" + String(s).replace(/\]/g, "]]") + "]"; }
function qSqlite(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

/** 值统一序列化成可展示的 JSON 兼容标量 */
function cellVal(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === "number" || typeof v === "boolean") return v;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Date) return v.toISOString();
	if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
	if (typeof v === "object") {
		let s;
		try {
			s = JSON.stringify(v, (k, x) => {
				if (x && typeof x === "object" && x._bsontype) {
					if (typeof x.toString === "function" && x.toString !== Object.prototype.toString) return x.toString();
				}
				if (typeof x === "bigint") return Number(x);
				return x;
			});
		} catch { s = String(v); }
		if (s.length > MAX_CELL_LEN) s = s.slice(0, MAX_CELL_LEN) + "…";
		return s;
	}
	const s = String(v);
	return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…" : s;
}

function rowsToGrid(columns, rows) {
	return {
		columns,
		rows: rows.map((r) => (Array.isArray(r) ? r.map(cellVal) : columns.map((c) => cellVal(r?.[c])))),
	};
}

function parseJsonFilter(text) {
	const t = String(text ?? "").trim();
	if (!t) return {};
	try {
		const obj = JSON.parse(t);
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("过滤条件必须是 JSON 对象");
		return obj;
	} catch (e) {
		throw new Error(`过滤条件 JSON 解析失败：${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// 适配器工厂 —— 每种数据库一个 async 工厂，返回统一接口 + kind
// ---------------------------------------------------------------------------

async function mysqlAdapter(cfg) {
	const mod = await import("mysql2/promise");
	const mysql = mod.default ?? mod;
	const conn = await withTimeout(mysql.createConnection({
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 3306,
		user: cfg.user || "root",
		password: cfg.password || undefined,
		connectTimeout: CONNECT_TIMEOUT_MS,
		dateStrings: true,
	}), CONNECT_TIMEOUT_MS + 3000, "建立连接");
	await conn.ping();
	let curDb = null;
	async function useDb(db) {
		if (db && db !== curDb) { await conn.query(`USE ${qMysql(db)}`); curDb = db; }
	}
	return {
		kind: "sql",
		dialect: "mysql",
		async listDatabases() {
			const [rows] = await conn.query("SHOW DATABASES");
			return rows.map((r) => Object.values(r)[0]).filter(Boolean);
		},
		async listTables(db) {
			const [rows] = await conn.query(
				`SELECT table_name AS name, table_type AS kind, IFNULL(table_rows,0) AS approx_rows
				 FROM information_schema.tables WHERE table_schema=? ORDER BY table_name`, [db]);
			return rows.map((r) => ({
				name: r.name, kind: r.kind === "VIEW" ? "view" : "table",
				approxRows: Number(r.approx_rows) || 0,
			}));
		},
		async describeTable(db, t) {
			const [cols] = await conn.query(
				`SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
				        column_default AS def, column_key AS ckey, extra, column_comment AS comment
				 FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`, [db, t]);
			const [idx] = await conn.query(
				`SELECT index_name AS name, NON_UNIQUE AS non_unique,
				        GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
				 FROM information_schema.statistics WHERE table_schema=? AND table_name=?
				 GROUP BY index_name, NON_UNIQUE`, [db, t]);
			let ddl = "";
			try {
				const [[row]] = await conn.query(`SHOW CREATE TABLE ${qMysql(db)}.${qMysql(t)}`);
				ddl = row["Create Table"] ?? row["Create View"] ?? "";
			} catch { /* 视图等场景失败可忽略 */ }
			return {
				columns: cols.map((c) => ({
					name: c.name, type: c.type, nullable: c.nullable === "YES",
					key: c.ckey || "", def: c.def ?? null, comment: c.comment || "",
				})),
				indexes: idx.map((i) => ({ name: i.name, unique: !Number(i.non_unique), columns: String(i.cols ?? "") })),
				ddl,
			};
		},
		async selectPage(db, t, opt) {
			// mysql 数据页不支持 JSON filter（那是 mongodb 专属参数）
			const totalRes = await conn.query(`SELECT COUNT(*) AS n FROM ${qMysql(db)}.${qMysql(t)}`);
			const total = Number(totalRes[0][0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qMysql(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const [rows] = await conn.query(
				`SELECT * FROM ${qMysql(db)}.${qMysql(t)}${orderSql} LIMIT ? OFFSET ?`,
				[Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0)]);
			const fields = rows.length ? Object.keys(rows[0])
				: (await conn.query(`SELECT * FROM ${qMysql(db)}.${qMysql(t)} LIMIT 1`))[0]?.fields?.map((f) => f.name)
					?? (await conn.query(
						`SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`, [db, t]))[0].map((r) => r.column_name);
			return { total, ...rowsToGrid(fields.length ? fields : ["*"], rows) };
		},
		async query(db, sql) {
			await useDb(db);
			const started = Date.now();
			const [result] = await conn.query(sql);
			if (Array.isArray(result)) {
				// SELECT 结果集
				const fields = result.length ? Object.keys(result[0]) : [];
				return { total: result.length, affected: 0, elapsedMs: Date.now() - started, ...rowsToGrid(fields, result) };
			}
			return { total: 0, affected: result?.affectedRows ?? 0, elapsedMs: Date.now() - started, columns: [], rows: [] };
		},
		async close() { try { await conn.end(); } catch { /* ignore */ } },
	};
}

async function postgresAdapter(cfg) {
	const mod = await import("pg");
	const Client = mod.default?.Client ?? mod.Client;
	const base = {
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 5432,
		user: cfg.user || "postgres",
		password: cfg.password || undefined,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
	};
	const curName = cfg.database || "postgres";
	const clients = new Map();
	async function getCli(name) {
		name = name || curName;
		let c = clients.get(name);
		if (c) return c;
		c = new Client({ ...base, database: name });
		await withTimeout(c.connect(), CONNECT_TIMEOUT_MS + 3000, "建立连接");
		clients.set(name, c);
		return c;
	}
	const main = await getCli(curName);
	return {
		kind: "sql",
		dialect: "postgres",
		async listDatabases() {
			const r = await main.query("SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn=true ORDER BY datname");
			return r.rows.map((x) => x.datname);
		},
		async listTables(db) {
			const c = await getCli(db);
			const r2 = await c.query(
				`SELECT c.relname AS name,
				        CASE WHEN c.relkind IN ('r','p') THEN 'table' ELSE 'view' END AS kind,
				        GREATEST(c.reltuples::bigint, 0)::text AS approx
				 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
				 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
				 ORDER BY c.relname`);
			return r2.rows.map((x) => ({ name: x.name, kind: x.kind, approxRows: Number(x.approx) || 0 }));
		},
		async describeTable(db, t) {
			const c = await getCli(db);
			const cols = await c.query(
				`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length AS max_len
				 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
			const pk = await c.query(
				`SELECT kcu.column_name FROM information_schema.table_constraints tc
				 JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
				 WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'`, [t]);
			const pkSet = new Set(pk.rows.map((x) => x.column_name));
			const idx = await c.query(
				`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1`, [t]);
			const ddlLines = cols.rows.map((c2) =>
				`  ${qPg(c2.column_name)} ${c2.data_type}${c2.max_len ? `(${c2.max_len})` : ""}${c2.is_nullable === "NO" ? " NOT NULL" : ""}${c2.column_default ? ` DEFAULT ${c2.column_default}` : ""}`);
			if (pkSet.size) ddlLines.push(`  PRIMARY KEY (${[...pkSet].map(qPg).join(", ")})`);
			return {
				columns: cols.rows.map((c2) => ({
					name: c2.column_name, type: c2.data_type + (c2.max_len ? `(${c2.max_len})` : ""),
					nullable: c2.is_nullable === "YES", key: pkSet.has(c2.column_name) ? "PRI" : "",
					def: c2.column_default ?? null, comment: "",
				})),
				indexes: idx.rows.map((i) => ({ name: i.indexname, unique: /CREATE UNIQUE/i.test(i.indexdef), columns: i.indexdef })),
				ddl: `CREATE TABLE ${qPg(t)} (\n${ddlLines.join(",\n")}\n);`,
			};
		},
		async selectPage(db, t, opt) {
			const c = await getCli(db);
			const cnt = await c.query(`SELECT COUNT(*)::bigint AS n FROM ${qPg("public")}.${qPg(t)}`);
			const total = Number(cnt.rows[0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qPg(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} NULLS LAST` : " ORDER BY 1";
			const r = await c.query(
				`SELECT * FROM ${qPg("public")}.${qPg(t)}${orderSql} LIMIT $1 OFFSET $2`,
				[Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0)]);
			const columns = r.fields.map((f) => f.name);
			return { total, ...rowsToGrid(columns, r.rows) };
		},
		async query(db, sql) {
			const c = await getCli(db || curName);
			const started = Date.now();
			const r = await c.query(sql);
			const columns = r.fields?.map((f) => f.name) ?? [];
			return {
				total: r.rows?.length ?? 0,
				affected: r.rowCount != null && !columns.length ? r.rowCount : 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.rows ?? []),
			};
		},
		async close() { for (const c of clients.values()) { try { await c.end(); } catch { /* ignore */ } } },
	};
}

async function sqliteAdapter(cfg) {
	if (!cfg.file || !String(cfg.file).trim()) throw new Error("SQLite 需要指定数据库文件路径");
	// 用 Node 内置 node:sqlite（≥22.13 无需 flag），零原生依赖；只读打开（文件必须存在，写入被拒）
	const mod = await import("node:sqlite");
	const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
	if (!DatabaseSync) throw new Error("当前 Node 不支持 node:sqlite（需 ≥22.13）");
	const db = new DatabaseSync(String(cfg.file).trim(), { readOnly: true });
	function all(sql, ...args) { return db.prepare(sql).all(...args); }
	return {
		kind: "sqlite",
		dialect: "sqlite",
		async listDatabases() { return ["main"]; },
		async listTables() {
			return all(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
				.map((r) => ({ name: r.name, kind: r.type === "view" ? "view" : "table", approxRows: 0 }));
		},
		async describeTable(_db, t) {
			const info = all(`PRAGMA table_info(${qSqlite(t)})`);
			const idxList = all(`PRAGMA index_list(${qSqlite(t)})`);
			const indexes = idxList.map((i) => {
				const cols = all(`PRAGMA index_info(${qSqlite(i.name)})`).map((x) => x.name);
				return { name: i.name, unique: !Number(i.unique), columns: cols.join(", ") };
			});
			const master = all(`SELECT sql FROM sqlite_master WHERE name=?`, t)[0];
			return {
				columns: info.map((c) => ({
					name: c.name, type: c.type || "", nullable: !Number(c.pk) ? c.notnull === 0 : false,
					key: Number(c.pk) ? "PRI" : "", def: c.dflt_value ?? null, comment: "",
				})),
				indexes,
				ddl: master?.sql ?? "",
			};
		},
		async selectPage(_db, t, opt) {
			const total = Number(all(`SELECT COUNT(*) AS n FROM ${qSqlite(t)}`)[0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qSqlite(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const rows = all(`SELECT * FROM ${qSqlite(t)}${orderSql} LIMIT ? OFFSET ?`,
				Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0));
			const colsRow = all(`PRAGMA table_info(${qSqlite(t)})`);
			return { total, ...rowsToGrid(colsRow.map((c) => c.name), rows) };
		},
		async query(_db, sql) {
			const started = Date.now();
			// 只读打开：仅允许读类语句
			if (!/^\s*(select|with|pragma|explain|values)\b/i.test(sql)) {
				throw new Error("SQLite 连接以只读模式打开（浏览用途），不支持写入语句");
			}
			const stmt = db.prepare(sql);
			const rows = stmt.all().slice(0, MAX_QUERY_ROWS);
			const columns = stmt.columns().map((c) => c.name);
			return { total: rows.length, affected: 0, elapsedMs: Date.now() - started, ...rowsToGrid(columns, rows) };
		},
		async close() { try { db.close(); } catch { /* ignore */ } },
	};
}

async function mssqlAdapter(cfg) {
	const ms = await import("mssql");
	const mssql = ms.default ?? ms;
	const baseCfg = {
		server: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 1433,
		user: cfg.user || "sa",
		password: cfg.password || "",
		database: cfg.database || "master",
		connectionTimeout: CONNECT_TIMEOUT_MS,
		requestTimeout: OP_TIMEOUT_MS,
		options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
	};
	const pools = new Map();
	async function getPool(name) {
		name = name || baseCfg.database;
		let p = pools.get(name);
		if (p) return p;
		p = new mssql.ConnectionPool({ ...baseCfg, database: name });
		await withTimeout(p.connect(), CONNECT_TIMEOUT_MS + 5000, "建立连接");
		pools.set(name, p);
		return p;
	}
	const main = await getPool(baseCfg.database);
	async function qual(db, t) {
		// 查真实 schema，避免写死 dbo
		const r = await (await getPool(db)).request()
			.input("t", mssql.VarChar(256), t)
			.query(`SELECT TOP 1 OBJECT_SCHEMA_NAME(object_id) AS s FROM ${qMssql(db)}.sys.objects WHERE name=@t AND type IN ('U','V')`);
		const schema = r.recordset[0]?.s || "dbo";
		return `${qMssql(db)}.${qMssql(schema)}.${qMssql(t)}`;
	}
	return {
		kind: "sql",
		dialect: "mssql",
		async listDatabases() {
			const r = await main.request().query("SELECT name FROM sys.databases WHERE state=0 ORDER BY name");
			return r.recordset.map((x) => x.name);
		},
		async listTables(db) {
			const r = await (await getPool(db)).request()
				.query(`SELECT name, CASE type WHEN 'U' THEN 'table' ELSE 'view' END AS kind FROM ${qMssql(db)}.sys.objects WHERE type IN ('U','V') ORDER BY name`);
			return r.recordset.map((x) => ({ name: x.name, kind: x.kind, approxRows: 0 }));
		},
		async describeTable(db, t) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const cols = await pool.request().input("t", mssql.VarChar(256), t).query(
				`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
				        CHARACTER_MAXIMUM_LENGTH AS max_len
				 FROM ${qMssql(db)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=@t ORDER BY ORDINAL_POSITION`);
			const pk = await pool.request().input("t", mssql.VarChar(256), t).query(
				`SELECT ku.COLUMN_NAME AS name FROM ${qMssql(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				 JOIN ${qMssql(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
				 WHERE tc.TABLE_NAME=@t AND tc.CONSTRAINT_TYPE='PRIMARY KEY'`);
			const pkSet = new Set(pk.recordset.map((x) => x.name));
			return {
				columns: cols.recordset.map((c) => ({
					name: c.name, type: c.type + (c.max_len && c.max_len > 0 && c.max_len < 8000 ? `(${c.max_len})` : ""),
					nullable: c.nullable === "YES", key: pkSet.has(c.name) ? "PRI" : "", def: c.def ?? null, comment: "",
				})),
				indexes: [],
				ddl: `-- ${fq}\n` + cols.recordset.map((c) =>
					`  ${c.name} ${c.type} ${c.nullable === "YES" ? "NULL" : "NOT NULL"}`).join("\n"),
			};
		},
		async selectPage(db, t, opt) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const totalR = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${fq}`);
			const total = Number(totalR.recordset[0]?.n ?? 0);
			const orderSql = opt.orderBy
				? ` ORDER BY ${qMssql(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`
				: ` ORDER BY (SELECT NULL) OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`;
			const r = await pool.request()
				.input("off", mssql.Int, Math.max(Number(opt.offset) || 0, 0))
				.input("lim", mssql.Int, Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.query(`SELECT * FROM ${fq}${orderSql}`);
			const columns = r.recordset.columns ? Object.keys(r.recordset.columns) : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
			return { total, ...rowsToGrid(columns, r.recordset) };
		},
		async query(db, sql) {
			const pool = await getPool(db || baseCfg.database);
			const started = Date.now();
			const r = await pool.request().query(sql);
			const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : [];
			return {
				total: r.recordset?.length ?? 0,
				affected: r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.recordset ?? []),
			};
		},
		async close() { for (const p of pools.values()) { try { await p.close(); } catch { /* ignore */ } } },
	};
}

async function mongoAdapter(cfg) {
	const mod = await import("mongodb");
	const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
	let url = cfg.uri;
	if (!url) {
		const auth = cfg.user ? `${encodeURIComponent(String(cfg.user))}:${encodeURIComponent(String(cfg.password || ""))}@` : "";
		url = `mongodb://${auth}${cfg.host || "127.0.0.1"}:${Number(cfg.port) || 27017}/${cfg.database ? encodeURIComponent(cfg.database) : ""}`;
	}
	const client = new MongoClient(url, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
	await withTimeout(client.connect(), CONNECT_TIMEOUT_MS + 3000, "建立连接");
	return {
		kind: "mongodb",
		dialect: "mongo",
		async listDatabases() {
			return (await client.db().admin().listDatabases()).databases.map((d) => d.name);
		},
		async listTables(db) {
			const colls = await client.db(db).listCollections().toArray();
			return colls.map((c) => ({ name: c.name, kind: c.type === "view" ? "view" : "collection", approxRows: 0 }));
		},
		async describeTable(db, t) {
			const coll = client.db(db).collection(t);
			let indexes = [];
			try { indexes = (await coll.listIndexes().toArray()).map((i) => ({ name: i.name, unique: Boolean(i.unique), columns: JSON.stringify(i.key) })); } catch { /* ignore */ }
			return { columns: [], indexes, ddl: `集合 ${db}.${t}（文档型无固定结构，请到「数据」页浏览）` };
		},
		async selectPage(db, t, opt) {
			const coll = client.db(db).collection(t);
			const filter = parseJsonFilter(opt.filter);
			const total = await coll.countDocuments(filter);
			const docs = await coll.find(filter)
				.skip(Math.max(Number(opt.offset) || 0, 0))
				.limit(Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.toArray();
			return { total, columns: ["doc"], rows: docs.map((d) => [cellVal(d)]) };
		},
		async query() { throw new Error("MongoDB 不支持 SQL——请在「数据」页用 JSON 过滤条件查询"); },
		async close() { try { await client.close(); } catch { /* ignore */ } },
	};
}

async function redisAdapter(cfg) {
	const mod = await import("ioredis");
	const RedisCtor = mod.default ?? mod.Redis ?? mod;
	const cli = new RedisCtor({
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 6379,
		password: cfg.password || undefined,
		db: Number(cfg.redisDb) > 0 ? Number(cfg.redisDb) : 0,
		maxRetriesPerRequest: 1,
		connectTimeout: CONNECT_TIMEOUT_MS,
		retryStrategy: () => null,
		lazyConnect: false,
	});
	cli.on("error", () => { /* 静默，操作层报错 */ });
	await withTimeout(cli.ping(), CONNECT_TIMEOUT_MS + 2000, "建立连接");

	async function scanKeys(pattern, cursorIn, want) {
		want = Math.min(Number(want) || 200, 1000);
		let cursor = String(cursorIn || "0");
		const keys = [];
		do {
			const [next, batch] = await cli.scan(cursor, "MATCH", pattern || "*", "COUNT", 200);
			cursor = next;
			for (const k of batch) if (keys.length < want) keys.push(k);
		} while (cursor !== "0" && keys.length < want);
		const capped = keys.slice(0, want);
		let types = [];
		if (capped.length) {
			const pipe = cli.pipeline();
			for (const k of capped) pipe.type(k);
			types = await pipe.exec();
		}
		return {
			cursor,
			keys: capped.map((k, i) => ({ key: k, type: types[i]?.[1] ?? "none" })),
		};
	}

	async function keyDetail(key) {
		const type = await cli.type(key);
		const ttl = await cli.ttl(key);
		let value = "";
		if (type === "string") value = (await cli.get(key)) ?? "(nil)";
		else if (type === "hash") {
			const h = await cli.hgetall(key);
			value = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
		} else if (type === "list") value = (await cli.lrange(key, 0, 199)).map((v, i) => `${i}: ${v}`).join("\n");
		else if (type === "set") value = [...(await cli.smembers(key))].slice(0, 200).join("\n");
		else if (type === "zset") {
			const z = await cli.zrange(key, 0, 199, "WITHSCORES");
			const lines = [];
			for (let i = 0; i < z.length; i += 2) lines.push(`${z[i]}  (score: ${z[i + 1]})`);
			value = lines.join("\n");
		} else if (type === "stream") {
			const r = await cli.xrange(key, "-", "+", "COUNT", 50);
			value = r.map(([id, fs]) => `${id} ${JSON.stringify(fs)}`).join("\n");
		} else value = `(类型 ${type} 暂不支持预览)`;
		if (value.length > 64_000) value = value.slice(0, 64_000) + "\n…[截断]";
		const size = type === "string"
			? (await cli.strlen(key))
			: type === "hash" ? await cli.hlen(key)
				: type === "list" ? await cli.llen(key)
					: type === "set" ? await cli.scard(key)
						: type === "zset" ? await cli.zcard(key)
							: type === "stream" ? await cli.xlen(key) : 0;
		return { type, ttl, size, value };
	}

	/** 简单命令行分词（支持单双引号） */
	function tokenize(line) {
		const out = [];
		let cur = "", quote = null;
		for (const ch of String(line)) {
			if (quote) { if (ch === quote) quote = null; else cur += ch; }
			else if (ch === '"' || ch === "'") quote = ch;
			else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
			else cur += ch;
		}
		if (cur) out.push(cur);
		return out;
	}

	return {
		kind: "redis",
		dialect: "redis",
		listDatabases: async () => [`db${Number(cfg.redisDb) || 0}`],
		listTables: async () => [],
		describeTable: async () => ({ columns: [], indexes: [], ddl: "" }),
		selectPage: async () => ({ total: 0, columns: [], rows: [] }),
		query: async () => { throw new Error("Redis 请使用「键」标签的原始命令输入"); },
		scanKeys, keyDetail,
		delKey: async (key) => await cli.del(key),
		runCmd: async (line) => {
			const args = tokenize(line);
			if (!args.length) throw new Error("空命令");
			return await cli.call(args[0], ...args.slice(1));
		},
		meta: async () => {
			const dbsize = await cli.dbsize();
			const mem = await cli.info("memory");
			const line = mem.split(/\r?\n/).find((l) => l.startsWith("used_memory_human"));
			return { dbsize, usedMemory: line ? line.split(":")[1]?.trim() : "?" };
		},
		async close() { try { cli.disconnect(); } catch { /* ignore */ } },
	};
}

const ADAPTER_FACTORIES = {
	mysql: mysqlAdapter,
	postgres: postgresAdapter,
	sqlite: sqliteAdapter,
	sqlserver: mssqlAdapter,
	mongodb: mongoAdapter,
	redis: redisAdapter,
};

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

const DRIVER_MODULE = {
	mysql: "mysql2", postgres: "pg", sqlite: "node:sqlite",
	sqlserver: "mssql", mongodb: "mongodb", redis: "ioredis",
};

export default {
	activate(host) {
		const st = {
			conns: [], // 连接配置 [{id,name,type,host,port,user,password,database,file,uri,redisDb}]
			runtime: new Map(), // connId → {connId, ownerId, hostId, label, adapter}
			nextConnId: 1,
			depsOk: false,
			depsInstalling: false,
			depsAvail: null,
		};

		// ---- 配置持久化 -------------------------------------------------------
		async function loadConfig() {
			try {
				const cfg = JSON.parse(await rf(join(host.dir, CONFIG_FILE), "utf8"));
				st.conns = Array.isArray(cfg.conns) ? cfg.conns : [];
			} catch { st.conns = []; }
		}
		async function saveConfig() {
			await wf(join(host.dir, CONFIG_FILE), JSON.stringify({ conns: st.conns }, null, "\t"), "utf8");
		}

		function publicConn(c) {
			return {
				id: c.id, name: c.name, type: c.type,
				host: c.host, port: c.port, user: c.user,
				database: c.database ?? "", file: c.file ?? "",
				hasPass: Boolean(c.password), hasUri: Boolean(c.uri),
				redisDb: c.redisDb ?? 0,
			};
		}

		function publicState() {
			return {
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				depsAvail: st.depsAvail,
				types: DB_TYPES,
				conns: st.conns.map(publicConn),
				active: [...st.runtime.values()].map((r) => ({ connId: r.connId, hostId: r.hostId, label: r.label })),
			};
		}

		function broadcastAll() { host.broadcast({ kind: "state", state: publicState() }); }

		function respond(action, reqId, clientId, extra = {}) {
			host.sendTo(clientId, { res: true, reqId, ok: true, action, ...extra });
		}
		function fail(action, reqId, clientId, error) {
			host.sendTo(clientId, { res: true, reqId, ok: false, action, error: String(error?.message ?? error) });
		}

		// ---- 依赖自动安装 -----------------------------------------------------
		async function loadDeps() {
			// 按驱动粒度探测可用性（只装了部分也能用对应类型）
			const results = await Promise.all(Object.entries(DRIVER_MODULE).map(async ([_type, name]) => {
				try { await import(name); return [name, true]; }
				catch { return [name, false]; }
			}));
			st.depsAvail = Object.fromEntries(results);
			st.depsOk = Object.values(st.depsAvail).every(Boolean);
			if (!st.depsOk) host.log("驱动可用性:", JSON.stringify(st.depsAvail));
			return st.depsOk;
		}

		function resolveNpmCli() {
			try { return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js"); }
			catch { return null; }
		}

		function installDeps(auto = false) {
			if (st.depsInstalling || st.depsOk) return;
			if (auto && process.env.PI_DB_CLIENT_NO_AUTOINSTALL) {
				host.log("auto install disabled by PI_DB_CLIENT_NO_AUTOINSTALL");
				return;
			}
			st.depsInstalling = true;
			broadcastAll();
			host.log(`installing deps: ${DEPS.join(" ")}${auto ? " (auto)" : ""}`);
			host.notify("info", "🗄️ 数据库插件：开始安装驱动依赖（首次约需几分钟）…");
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", ...DEPS, "--no-audit", "--no-fund"];
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
				: spawn("npm", args, { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
			let errTail = "";
			child.stderr?.on("data", (d) => { errTail = (errTail + d.toString()).slice(-1000); });
			let done = false;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (ok) await loadDeps();
				// 取 stderr 最后一个非空行（通常是 npm error 摘要），避免只有干巴巴的 exit 码
				const lastErr = errTail.split(/\r?\n/).filter(Boolean).pop() ?? "";
				host.notify(
					ok ? "success" : "error",
					ok
						? "🗄️ 数据库插件驱动安装完成"
						: `🗄️ 数据库插件驱动安装失败（${why}${lastErr ? `：${lastErr}` : ""}）——请在插件目录手动执行：npm install ${DEPS.join(" ")}`,
				);
				broadcastAll();
			}
		}

		// ---- 连接管理 ---------------------------------------------------------
		function getRuntime(connId) {
			const r = st.runtime.get(connId);
			if (!r) throw new Error(`连接不存在或已断开：${connId}`);
			return r;
		}

		function dropRuntime(r, reason) {
			if (!st.runtime.has(r.connId)) return;
			st.runtime.delete(r.connId);
			void Promise.resolve(r.adapter?.close?.()).catch(() => {});
			host.sendTo(r.ownerId, { event: "conn_closed", connId: r.connId, reason: reason ?? "" });
			broadcastAll();
		}

		async function openAdapter(cfg) {
			const factory = ADAPTER_FACTORIES[cfg.type];
			if (!factory) throw new Error(`未知数据库类型：${cfg.type}`);
			const driver = DRIVER_MODULE[cfg.type];
			if (st.depsAvail?.[driver] === false) {
				throw new Error(`驱动 ${driver} 未安装——请点左侧「安装驱动」或手动在插件目录执行 npm install ${driver}`);
			}
			try {
				return await factory(cfg);
			} catch (err) {
				if (/Cannot find|ERR_MODULE_NOT_FOUND/.test(String(err?.message ?? err))) {
					throw new Error(`驱动 ${driver} 未安装——请点左侧「安装驱动」或手动在插件目录执行 npm install ${driver}`);
				}
				throw err;
			}
		}

		// ------------------------------------------------------------------
		// 消息路由
		// ------------------------------------------------------------------
		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;

			const reply = (err, extra) =>
				err ? fail(action, reqId, clientId, err)
					: respond(action, reqId, clientId, extra ?? {});
			try {
				switch (action) {
					case "state":
						return void respond(action, reqId, clientId, { state: publicState() });
					case "deps_install":
						installDeps(false);
						return void respond(action, reqId, clientId, {});

					case "conns_save": {
						const c = msg.conn ?? {};
						if (!DB_TYPES[c.type]) throw new Error("请选择数据库类型");
						if (c.type !== "sqlite" && !String(c.host ?? "").trim()) throw new Error("主机地址不能为空");
						if (c.id) {
							const i = st.conns.findIndex((x) => x.id === c.id);
							if (i < 0) throw new Error("连接不存在");
							const old = st.conns[i];
							st.conns[i] = {
								...old,
								name: c.name ?? old.name,
								type: old.type, // 类型不允许改（驱动语义差异大）
								host: c.type !== "sqlite" ? String(c.host ?? "").trim() : old.host,
								port: Number(c.port) || old.port,
								user: c.user ?? old.user,
								// 凭据留空 = 沿用旧值；显式 null = 清除
								password: c.password === null ? undefined : (c.password || old.password),
								database: c.database ?? old.database,
								file: c.file ?? old.file,
								uri: c.uri === null ? undefined : (c.uri || old.uri),
								redisDb: Number.isFinite(+c.redisDb) ? +c.redisDb : old.redisDb,
							};
						} else {
							if (st.conns.length >= MAX_CONNS) throw new Error(`最多保存 ${MAX_CONNS} 个连接`);
							st.conns.push({
								id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
								name: String(c.name || `${DB_TYPES[c.type].label} ${c.host || c.file || ""}`).trim(),
								type: c.type,
								host: String(c.host ?? "").trim(),
								port: Number(c.port) || DB_TYPES[c.type].port,
								user: c.user ?? "",
								password: c.password ? String(c.password) : undefined,
								database: c.database ?? "",
								file: c.file ?? "",
								uri: c.uri ? String(c.uri).trim() : undefined,
								redisDb: Number(c.redisDb) || 0,
							});
						}
						await saveConfig();
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "conns_delete": {
						const before = st.conns.length;
						st.conns = st.conns.filter((x) => x.id !== msg.id);
						if (st.conns.length === before) throw new Error("连接不存在");
						await saveConfig();
						for (const r of [...st.runtime.values()]) if (r.hostId === msg.id) dropRuntime(r, "连接配置已删除");
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "test": {
						// 表单测试：完整 conn 对象（编辑时密码留空则沿用已存值）
						let cfg = { ...msg.conn };
						if (cfg.id) {
							const saved = st.conns.find((x) => x.id === cfg.id);
							if (saved && !cfg.password) cfg.password = saved.password;
							if (saved) cfg.type = saved.type; // 类型不可改
						}
						cfg.port = Number(cfg.port) || DB_TYPES[cfg.type]?.port || 0;
						const adapter = await openAdapter(cfg);
						await adapter.close();
						return void respond(action, reqId, clientId, {});
					}

					case "connect": {
						const cfg = st.conns.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("连接不存在");
						for (const r of st.runtime.values()) {
							if (r.hostId === cfg.id) { // 已开 → 直接复用
								return void respond(action, reqId, clientId, { connId: r.connId, label: r.label, kind: r.adapter.kind, dialect: r.adapter.dialect });
							}
						}
						if (st.runtime.size >= MAX_RUNTIME) throw new Error(`最多同时打开 ${MAX_RUNTIME} 个连接，请先断开一些`);
						const adapter = await openAdapter(cfg);
						const connId = `c${st.nextConnId++}`;
						const r = { connId, ownerId: clientId, hostId: cfg.id, label: cfg.name || cfg.host || cfg.file || cfg.type, adapter };
						st.runtime.set(connId, r);
						broadcastAll();
						return void respond(action, reqId, clientId, { connId, label: r.label, kind: adapter.kind, dialect: adapter.dialect });
					}

					case "disconnect": {
						dropRuntime(getRuntime(msg.connId), "手动断开");
						return void respond(action, reqId, clientId, {});
					}

					// ---- 通用 SQL/NoSQL 浏览 ----
					case "dbs_list": {
						const r = getRuntime(msg.connId);
						return void respond(action, reqId, clientId, { databases: await withTimeout(r.adapter.listDatabases(), OP_TIMEOUT_MS, "查询") });
					}
					case "tables_list": {
						const r = getRuntime(msg.connId);
						const tables = await withTimeout(r.adapter.listTables(msg.db), OP_TIMEOUT_MS, "查询");
						tables.sort((a, b) => a.name.localeCompare(b.name));
						return void respond(action, reqId, clientId, { tables });
					}
					case "describe": {
						const r = getRuntime(msg.connId);
						const d = await withTimeout(r.adapter.describeTable(msg.db, msg.table), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, { describe: d });
					}
					case "page": {
						const r = getRuntime(msg.connId);
						const grid = await withTimeout(r.adapter.selectPage(msg.db, msg.table, {
							offset: msg.offset, limit: msg.limit,
							orderBy: msg.orderBy, dir: msg.dir, filter: msg.filter,
						}), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, { grid });
					}
					case "query_exec": {
						const r = getRuntime(msg.connId);
						const sql = String(msg.sql ?? "");
						if (!sql.trim()) throw new Error("SQL 为空");
						const grid = await withTimeout(r.adapter.query(msg.db, sql), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, { grid });
					}

					// ---- Redis 专属 ----
					case "redis_scan": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.scanKeys) throw new Error("该连接不是 Redis");
						const out = await withTimeout(r.adapter.scanKeys(msg.pattern, msg.cursor, msg.count), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, out);
					}
					case "redis_key": {
						const r = getRuntime(msg.connId);
						const detail = await withTimeout(r.adapter.keyDetail(String(msg.key ?? "")), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, { detail });
					}
					case "redis_del": {
						const r = getRuntime(msg.connId);
						const n = await withTimeout(r.adapter.delKey(String(msg.key ?? "")), OP_TIMEOUT_MS, "删除");
						return void respond(action, reqId, clientId, { deleted: Number(n) || 0 });
					}
					case "redis_cmd": {
						const r = getRuntime(msg.connId);
						const out = await withTimeout(r.adapter.runCmd(String(msg.cmd ?? "")), OP_TIMEOUT_MS, "命令");
						return void respond(action, reqId, clientId, { output: cellVal(out) });
					}
					case "redis_meta": {
						const r = getRuntime(msg.connId);
						const meta = await withTimeout(r.adapter.meta(), OP_TIMEOUT_MS, "查询");
						return void respond(action, reqId, clientId, { meta });
					}

					default:
						return void fail(action, reqId, clientId, `未知操作 ${action}`);
				}
			} catch (err) {
				fail(action, reqId, clientId, err);
			}
		});

		void loadConfig().then(async () => {
			const ok = await loadDeps();
			if (!ok) installDeps(true);
			broadcastAll();
		});

		host.log("activated");
		return () => {
			off();
			for (const r of st.runtime.values()) {
				try { void r.adapter?.close?.(); } catch { /* ignore */ }
			}
			st.runtime.clear();
		};
	},
};
