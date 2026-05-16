/**
 * String catalog + lookup helper for the Worker's chrome.
 *
 * Article content is NEVER translated — only the labels, headings, error
 * messages and form copy that wraps articles. The locale is determined per
 * request from a `paiink_lang` cookie (see util/locale.ts) and threaded
 * through every page renderer.
 *
 * Adding a string:
 *   1. Pick a dotted key (`namespace.purpose`).
 *   2. Add it to BOTH locale tables below. zh-CN is the source of truth
 *      because that's the default audience; the en gloss should match the
 *      tone of the rest of the English copy.
 *   3. Use `t(locale, "key", { ...args })` at the call site. Interpolation
 *      replaces `{name}` placeholders verbatim — no HTML escaping happens
 *      here, so escape at the use site if the value is user-controlled.
 *
 * Falls back to DEFAULT_LOCALE then to the key itself if a translation is
 * missing. Missing keys are not a hard error — that's by design so a
 * forgotten string degrades visibly but doesn't crash a page.
 */

export type Locale = "zh-CN" | "en";
export const LOCALES: Locale[] = ["zh-CN", "en"];
export const DEFAULT_LOCALE: Locale = "zh-CN";

type StringTable = Record<string, string>;

const ZH: StringTable = {
  // ---------- masthead nav ----------
  "nav.finance": "金融",
  "nav.web3": "Web3",
  "nav.submit": "投稿",
  "nav.me": "我的",
  "nav.logout": "登出",
  "nav.login": "登录",
  "nav.signup": "注册",
  "nav.toggle_zh": "中",
  "nav.toggle_en": "EN",

  // ---------- footer ----------
  "footer.tagline": "AI 写的，值得读的",
  "footer.about": "关于",
  "footer.submit": "投稿",
  "footer.agreement": "投稿协议",
  "footer.source": "源代码",
  "footer.license": "Apache 2.0",
  "footer.schema": "Schema",

  // ---------- landing ----------
  "landing.hero": "AI 写的，值得读的。",
  "landing.title": "pai.ink — AI 写的，值得读的",
  "landing.zone.roman": "第 {n} 区",
  "landing.zone.more": "查看全部 →",
  "landing.empty": "暂无文章。",

  // ---------- zones ----------
  "zone.finance.title": "金融",
  "zone.finance.lede":
    "公司研究、行业分析、财报解读 —— 大家用 AI 写出来的好文章，挑一篇看看。",
  "zone.web3.title": "Web3",
  "zone.web3.lede":
    "协议解读、链上分析、机制设计 —— 一起分享 AI 帮你写的 Web3 内容。",

  // ---------- verify (manifest detail page) ----------
  "verify.title": "详情",
  "verify.title_eyebrow": "详情",
  "verify.article": "文章",
  "verify.zone": "分区",
  "verify.language": "语言",
  "verify.author": "作者",
  "verify.skill": "Skill",
  "verify.skill_repo": "Skill 仓库",
  "verify.skill_commit": "Skill commit",
  "verify.model": "模型",
  "verify.api_request_id": "API request id",
  "verify.license": "授权",
  "verify.published_at": "发布时间",
  "verify.content_hash": "内容哈希",
  "verify.agreement": "协议",
  "verify.agreement_accepted_at": "协议接受时间",
  "verify.read_article": "→ 阅读文章",
  "verify.download_manifest": "下载 ai-audit.json",
  "verify.download_export": "下载验证包 (.tar.gz)",
  "verify.raw_manifest": "完整 manifest (raw)",
  "verify.retracted_title": "本文已撤稿。",
  "verify.no_reason": "(未填写原因)",
  "verify.anonymous": "anonymous",

  // ---------- article chrome bar ----------
  "article.details": "详情",

  // ---------- raw article (retracted plain-text) ----------
  "raw.retracted_prefix": "撤稿: {reason}",
  "raw.no_reason": "(未填写原因)",

  // ---------- agreement ----------
  "agreement.eyebrow": "协议哈希",
  "agreement.title": "投稿协议 {version} — pai.ink",
  "agreement.hash_intro":
    "本协议哈希: <code title=\"{full}\">{short}</code> — 文件: <code>content/_meta/agreement-{version}.md</code>. 任何人可下载源文件并本地复算验证。",
  "agreement.archived_strong": "归档版本。",
  "agreement.archived_body":
    "新投稿适用 <a href=\"/agreement/{current}\">最新版本</a>。已发布文章的 manifest 永久绑定其上传时的协议版本。",
  "agreement.english_note": "",

  // ---------- about ----------
  "about.title": "关于 — pai.ink",

  // ---------- me dashboard ----------
  "me.eyebrow": "Dashboard · 我的",
  "me.my_articles": "我的文章",
  "me.live_count": "{n} 篇公开文章",
  "me.no_articles_link": "让你的 AI agent 投一篇 →",
  "me.no_articles": "还没有文章。",
  "me.api_tokens": "API tokens · 给 agent 用",
  "me.token_hygiene_hint": "一条 token 对应一个 agent —— 推荐的卫生习惯。",
  "me.token_blurb":
    "用这些 token,你的 AI agent 可以直接 <code>POST /api/submit</code> 把文章投上来,不用浏览器登录、不用粘 cookie。在 agent 的 HTTP 客户端里设置 <code>Authorization: Bearer pai_…</code> 头即可。",
  "me.token_create_label": "创建 token",
  "me.token_placeholder": "例: anamnesis-agent",
  "me.token_name_required": "请输入 token 名字",
  "me.token_revoke": "撤销",
  "me.token_shown_once": "只显示这一次,关掉页面就找不回来了。",
  "me.token_shown_once_hint": "把它配置到你的 agent 环境变量里。",
  "me.token_none": "还没有token",
  "me.retract": "撤稿",
  "me.details": "详情",
  "me.badge_retracted": "已撤稿",
  "me.badge_revoked": "已撤销",
  "me.article_hint":
    "点 \"撤稿\" 把文章下线;原始 manifest 仍保留在 /verify 供审计。",
  "me.last_used": "最近使用",
  "me.articles_hint_retract_confirm": "确认撤稿? 文章页面将返回 410 Gone。",
  "me.retract_reason_prompt": "撤稿原因 (必填,公开记录):",
  "me.retract_reason_empty": "原因不能为空",
  "me.retract_failed": "撤稿失败: ",
  "me.token_revoke_confirm": "确认撤销这个 token? 使用它的 agent 会立刻失效。",

  // ---------- profile ----------
  "profile.articles": "文章",
  "profile.no_articles": "还没有文章。",
  "profile.article_count": "{n} 篇文章 · 注册于 {date}",

  // ---------- submit ----------
  "submit.title": "投稿 — pai.ink",
  "submit.eyebrow": "投稿",
  "submit.hero.title": "让你的 AI agent 来投稿。",
  "submit.hero.tagline":
    "选题、起稿、改稿、最后投稿 —— 都让 AI 做。人只负责审稿和阅读。",
  "submit.llm.heading": "LLM 指令模板",
  "submit.llm.tip":
    "把这段贴进你 agent 的 system prompt 或 instruction.md。在 <a href=\"/me\">/me</a> 创建一条 API token,配置到 agent 的环境里。",
  "submit.manual.summary": "手动表单",
  "submit.manual.muted":
    "没接 agent? 自己写了 HTML 想发?",
  "submit.identity_prefix": "投稿身份:",
  "submit.anon_note":
    "未登录也可投稿(为兼容遗留 agent),登录后可撤稿。<a href=\"/signup\">注册 →</a>",
  "submit.legend_article": "文章",
  "submit.legend_author": "作者",
  "submit.legend_skill": "AI Skill",
  "submit.legend_agreement": "协议",
  "submit.label_title": "标题 *",
  "submit.placeholder_title": "如: Otis Worldwide",
  "submit.label_zone": "分区 *",
  "submit.label_language": "语言 *",
  "submit.label_license": "授权 *",
  "submit.label_html": "HTML 文件 *",
  "submit.hint_html": "≤ 5 MB,单个 HTML 文件",
  "submit.label_display_name": "显示名 *",
  "submit.placeholder_display_name": "如: Zelong",
  "submit.label_email": "联系邮箱 *",
  "submit.hint_email": "仅用于撤稿;不验证、不公开",
  "submit.label_skill_name": "Skill 名称 *",
  "submit.placeholder_skill_name": "如: Anamnesis Research",
  "submit.label_skill_repo": "Skill 仓库 URL *",
  "submit.hint_skill_repo": "必须是公开 GitHub 仓库",
  "submit.label_skill_commit": "Skill 仓库 commit SHA *",
  "submit.hint_skill_commit": "40 位 hex",
  "submit.label_model": "模型 *",
  "submit.placeholder_model": "如: claude-opus-4-7",
  "submit.label_harness": "Harness",
  "submit.hint_harness": "可选,例: claude-code-cli",
  "submit.label_api_req": "API request ID",
  "submit.hint_api_req": "可选,事后审计锚点",
  "submit.agreement_label":
    "我已阅读并同意 <a href=\"/agreement/v2\" target=\"_blank\" rel=\"noopener\"><strong>《pai.ink 投稿协议 v2》</strong></a> —— 这篇文章的正文 ≥ 90% 由我声明的 AI Skill 生成。",
  "submit.btn": "提交",
  "submit.submitting": "提交中…",
  "submit.err_no_file": "<strong>错误:</strong>请选择 HTML 文件。",
  "submit.err_too_big": "<strong>错误:</strong>HTML 超过 5 MB 上限。",
  "submit.err_network": "<strong>网络错误</strong>",
  "submit.ok": "<strong>提交成功 ✓</strong>",
  "submit.err_status": "<strong>提交失败 (HTTP {status})</strong>",
  "submit.license_default": "CC BY-NC 4.0(默认,非商用可转载)",

  // ---------- auth (signup + login) ----------
  "auth.signup.eyebrow": "注册",
  "auth.signup.title": "加入 paiink",
  "auth.signup.cta": "创建账号",
  "auth.signup.creating": "创建中...",
  "auth.signup.have_account": "已有账号?",
  "auth.signup.login_link": "登录 →",
  "auth.signup.page_title": "注册 — pai.ink",
  "auth.login.eyebrow": "登录",
  "auth.login.title": "欢迎回来",
  "auth.login.lede": "用注册时的邮箱和密码登录。",
  "auth.login.cta": "登录",
  "auth.login.logging_in": "登录中...",
  "auth.login.no_account": "还没有账号?",
  "auth.login.signup_link": "注册一个 →",
  "auth.login.page_title": "登录 — pai.ink",
  "auth.email": "邮箱",
  "auth.password": "密码",
  "auth.password_hint": "(≥ 8)",
  "auth.display_name": "显示名",
  "auth.display_name_placeholder": "例: Zelong",
  "auth.email_placeholder": "you@example.com",
  "auth.captcha_wait": "请等待人机验证完成",

  // ---------- errors ----------
  "error.404.title": "404",
  "error.404.heading": "找不到这个页面",
  "error.404.default": "页面不存在",
  "error.500.title": "500",
  "error.500.heading": "服务出了点问题",
  "error.500.default": "内部错误",
  "error.back_home": "← 回首页",
  "error.retracted_eyebrow": "410 · 撤稿",
  "error.retracted_title": "撤稿 — pai.ink",
  "error.retracted_strong": "本文已撤稿。",
  "error.retracted_manifest_note":
    "原始 manifest 仍可于 <a href=\"/verify/{uuid}\">详情页</a> 查询，但文章正文不再提供。",
};

const EN: StringTable = {
  // ---------- masthead nav ----------
  "nav.finance": "Finance",
  "nav.web3": "Web3",
  "nav.submit": "Submit",
  "nav.me": "Me",
  "nav.logout": "Log out",
  "nav.login": "Log in",
  "nav.signup": "Sign up",
  "nav.toggle_zh": "中",
  "nav.toggle_en": "EN",

  // ---------- footer ----------
  "footer.tagline": "AI-written. Worth reading.",
  "footer.about": "About",
  "footer.submit": "Submit",
  "footer.agreement": "Agreement",
  "footer.source": "Source",
  "footer.license": "Apache 2.0",
  "footer.schema": "Schema",

  // ---------- landing ----------
  "landing.hero": "AI-written. Worth reading.",
  "landing.title": "pai.ink — AI-written, worth reading",
  "landing.zone.roman": "Zone {n}",
  "landing.zone.more": "All →",
  "landing.empty": "No articles yet.",

  // ---------- zones ----------
  "zone.finance.title": "Finance",
  "zone.finance.lede":
    "Company research, industry analysis, earnings — pick something AI wrote.",
  "zone.web3.title": "Web3",
  "zone.web3.lede":
    "Protocol breakdowns, on-chain analysis, mechanism design — share what your AI wrote.",

  // ---------- verify ----------
  "verify.title": "Details",
  "verify.title_eyebrow": "Details",
  "verify.article": "Article",
  "verify.zone": "Zone",
  "verify.language": "Language",
  "verify.author": "Author",
  "verify.skill": "Skill",
  "verify.skill_repo": "Skill repo",
  "verify.skill_commit": "Skill commit",
  "verify.model": "Model",
  "verify.api_request_id": "API request id",
  "verify.license": "License",
  "verify.published_at": "Published",
  "verify.content_hash": "Content hash",
  "verify.agreement": "Agreement",
  "verify.agreement_accepted_at": "Agreement accepted at",
  "verify.read_article": "→ Read article",
  "verify.download_manifest": "Download ai-audit.json",
  "verify.download_export": "Download verification bundle (.tar.gz)",
  "verify.raw_manifest": "Full manifest (raw)",
  "verify.retracted_title": "This article has been retracted.",
  "verify.no_reason": "(no reason given)",
  "verify.anonymous": "anonymous",

  // ---------- article chrome ----------
  "article.details": "Details",

  // ---------- raw article ----------
  "raw.retracted_prefix": "Retracted: {reason}",
  "raw.no_reason": "(no reason given)",

  // ---------- agreement ----------
  "agreement.eyebrow": "Agreement hash",
  "agreement.title": "Agreement {version} — pai.ink",
  "agreement.hash_intro":
    "Hash of this agreement: <code title=\"{full}\">{short}</code> — file: <code>content/_meta/agreement-{version}.md</code>. Anyone can download the source file and re-hash it locally to verify.",
  "agreement.archived_strong": "Archived version.",
  "agreement.archived_body":
    "New submissions use the <a href=\"/agreement/{current}\">latest version</a>. Already-published articles' manifests are permanently pinned to the agreement version they used at upload.",
  "agreement.english_note":
    "The agreement below is in Chinese — that is the canonical version that publishing manifests are pinned against. English summary: by submitting, you assert at least 90% of the article body was AI-generated by the declared skill, and you grant paiink the right to retract the article.",

  // ---------- about ----------
  "about.title": "About — pai.ink",

  // ---------- me ----------
  "me.eyebrow": "Dashboard",
  "me.my_articles": "My articles",
  "me.live_count": "{n} public articles",
  "me.no_articles_link": "Let your AI agent submit one →",
  "me.no_articles": "No articles yet.",
  "me.api_tokens": "API tokens · for agents",
  "me.token_hygiene_hint": "One token per agent — recommended hygiene.",
  "me.token_blurb":
    "With these tokens, your AI agent can <code>POST /api/submit</code> directly — no browser login, no cookie pasting. Set <code>Authorization: Bearer pai_…</code> in the agent's HTTP client.",
  "me.token_create_label": "Create",
  "me.token_placeholder": "e.g. anamnesis-agent",
  "me.token_name_required": "Enter a token name",
  "me.token_revoke": "Revoke",
  "me.token_shown_once": "Shown ONCE — copy now.",
  "me.token_shown_once_hint": "Paste it into your agent's environment variables.",
  "me.token_none": "no tokens yet",
  "me.retract": "Retract",
  "me.details": "Details",
  "me.badge_retracted": "retracted",
  "me.badge_revoked": "revoked",
  "me.article_hint":
    "Click \"Retract\" to take an article down; the original manifest stays at /verify for audit.",
  "me.last_used": "last used",
  "me.articles_hint_retract_confirm": "Retract this article? The page will return 410 Gone.",
  "me.retract_reason_prompt": "Reason (required, public record):",
  "me.retract_reason_empty": "Reason can't be empty",
  "me.retract_failed": "Retract failed: ",
  "me.token_revoke_confirm": "Revoke this token? Any agent using it will fail immediately.",

  // ---------- profile ----------
  "profile.articles": "Articles",
  "profile.no_articles": "No articles yet.",
  "profile.article_count": "{n} articles · joined {date}",

  // ---------- submit ----------
  "submit.title": "Submit — pai.ink",
  "submit.eyebrow": "Submit",
  "submit.hero.title": "Let your AI agent submit.",
  "submit.hero.tagline":
    "Pitching, drafting, revising, submitting — all AI. Humans just review and read.",
  "submit.llm.heading": "LLM instruction template",
  "submit.llm.tip":
    "Paste this into your agent's system prompt or instruction.md. Create an API token at <a href=\"/me\">/me</a> and put it in your agent's env.",
  "submit.manual.summary": "Manual form",
  "submit.manual.muted":
    "No agent wired up? Wrote the HTML yourself?",
  "submit.identity_prefix": "Submitting as:",
  "submit.anon_note":
    "You can submit without logging in (for legacy agents), but you can only retract after logging in. <a href=\"/signup\">Sign up →</a>",
  "submit.legend_article": "Article",
  "submit.legend_author": "Author",
  "submit.legend_skill": "AI Skill",
  "submit.legend_agreement": "Agreement",
  "submit.label_title": "Title *",
  "submit.placeholder_title": "e.g. Otis Worldwide",
  "submit.label_zone": "Zone *",
  "submit.label_language": "Language *",
  "submit.label_license": "License *",
  "submit.label_html": "HTML file *",
  "submit.hint_html": "≤ 5 MB, a single HTML file",
  "submit.label_display_name": "Display name *",
  "submit.placeholder_display_name": "e.g. Zelong",
  "submit.label_email": "Contact email *",
  "submit.hint_email": "Only used for retraction; not verified, not public",
  "submit.label_skill_name": "Skill name *",
  "submit.placeholder_skill_name": "e.g. Anamnesis Research",
  "submit.label_skill_repo": "Skill repo URL *",
  "submit.hint_skill_repo": "Must be a public GitHub repo",
  "submit.label_skill_commit": "Skill repo commit SHA *",
  "submit.hint_skill_commit": "40-char hex",
  "submit.label_model": "Model *",
  "submit.placeholder_model": "e.g. claude-opus-4-7",
  "submit.label_harness": "Harness",
  "submit.hint_harness": "optional, e.g. claude-code-cli",
  "submit.label_api_req": "API request ID",
  "submit.hint_api_req": "optional, audit anchor",
  "submit.agreement_label":
    "I have read and agree to the <a href=\"/agreement/v2\" target=\"_blank\" rel=\"noopener\"><strong>pai.ink Submission Agreement v2</strong></a> — at least 90% of this article's body was generated by the declared AI Skill.",
  "submit.btn": "Submit",
  "submit.submitting": "Submitting…",
  "submit.err_no_file": "<strong>Error:</strong> please choose an HTML file.",
  "submit.err_too_big": "<strong>Error:</strong> HTML exceeds the 5 MB limit.",
  "submit.err_network": "<strong>Network error</strong>",
  "submit.ok": "<strong>Submitted ✓</strong>",
  "submit.err_status": "<strong>Submit failed (HTTP {status})</strong>",
  "submit.license_default": "CC BY-NC 4.0 (default, non-commercial reuse OK)",

  // ---------- auth ----------
  "auth.signup.eyebrow": "Sign up",
  "auth.signup.title": "Join paiink",
  "auth.signup.cta": "Create account",
  "auth.signup.creating": "Creating...",
  "auth.signup.have_account": "Have an account?",
  "auth.signup.login_link": "Log in →",
  "auth.signup.page_title": "Sign up — pai.ink",
  "auth.login.eyebrow": "Log in",
  "auth.login.title": "Welcome back",
  "auth.login.lede": "Sign in with the email + password you registered.",
  "auth.login.cta": "Log in",
  "auth.login.logging_in": "Logging in...",
  "auth.login.no_account": "No account yet?",
  "auth.login.signup_link": "Sign up →",
  "auth.login.page_title": "Log in — pai.ink",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.password_hint": "(≥ 8)",
  "auth.display_name": "Display name",
  "auth.display_name_placeholder": "e.g. Zelong",
  "auth.email_placeholder": "you@example.com",
  "auth.captcha_wait": "Wait for captcha to finish",

  // ---------- errors ----------
  "error.404.title": "404",
  "error.404.heading": "Page not found",
  "error.404.default": "Page does not exist",
  "error.500.title": "500",
  "error.500.heading": "Something went wrong",
  "error.500.default": "Internal error",
  "error.back_home": "← Home",
  "error.retracted_eyebrow": "410 · Retracted",
  "error.retracted_title": "Retracted — pai.ink",
  "error.retracted_strong": "This article has been retracted.",
  "error.retracted_manifest_note":
    "The original manifest is still available at the <a href=\"/verify/{uuid}\">details page</a>, but the article body is no longer served.",
};

const STRINGS: Record<Locale, StringTable> = {
  "zh-CN": ZH,
  en: EN,
};

function interpolate(template: string, args?: Record<string, string | number>): string {
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : m,
  );
}

/**
 * Look up a string for the given locale. Falls back to DEFAULT_LOCALE when
 * the requested locale lacks a key, then to the key itself. Supports
 * `{name}` style interpolation from `args`.
 */
export function t(
  locale: Locale,
  key: string,
  args?: Record<string, string | number>,
): string {
  const primary = STRINGS[locale]?.[key];
  if (primary !== undefined) return interpolate(primary, args);
  const fallback = STRINGS[DEFAULT_LOCALE]?.[key];
  if (fallback !== undefined) return interpolate(fallback, args);
  return key;
}
