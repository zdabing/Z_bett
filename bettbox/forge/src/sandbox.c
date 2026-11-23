/* SPDX-License-Identifier: GPL-3.0 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "sandbox.h"
#include "quickjs.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define FORGE_MAX_DEPTH     128
#define FORGE_MAX_LOG_LINES 200
#define FORGE_MAX_LOG_BYTES (64U * 1024U)

typedef struct {
	char *data;
	size_t len;
	size_t cap;
} StrBuf;

typedef struct {
	uint64_t deadline_ns;
	int timed_out;
	int capture_logs;
	char **logs;
	size_t log_count;
	size_t log_bytes;
} SandboxState;

static char *xstrdup(const char *s)
{
	size_t n;
	char *p;
	if (!s)
		return NULL;
	n = strlen(s);
	p = (char *)malloc(n + 1);
	if (!p)
		return NULL;
	memcpy(p, s, n + 1);
	return p;
}

static char *xstrndup(const char *s, size_t n)
{
	char *p = (char *)malloc(n + 1);
	if (!p)
		return NULL;
	if (n > 0)
		memcpy(p, s, n);
	p[n] = '\0';
	return p;
}

static int sb_reserve(StrBuf *sb, size_t extra)
{
	size_t need = sb->len + extra + 1;
	size_t new_cap;
	char *next;
	if (need <= sb->cap)
		return 0;
	new_cap = sb->cap ? sb->cap : 256;
	while (new_cap < need)
		new_cap *= 2;
	next = (char *)realloc(sb->data, new_cap);
	if (!next)
		return -1;
	sb->data = next;
	sb->cap = new_cap;
	return 0;
}

static int sb_append_n(StrBuf *sb, const char *s, size_t n)
{
	if (sb_reserve(sb, n) != 0)
		return -1;
	if (n > 0)
		memcpy(sb->data + sb->len, s, n);
	sb->len += n;
	sb->data[sb->len] = '\0';
	return 0;
}

static int sb_append(StrBuf *sb, const char *s)
{
	return sb_append_n(sb, s, strlen(s));
}

static int sb_append_json_str(StrBuf *sb, const char *s)
{
	static const char hex[] = "0123456789abcdef";
	const unsigned char *p = (const unsigned char *)(s ? s : "");
	if (sb_append_n(sb, "\"", 1) != 0)
		return -1;
	while (*p) {
		unsigned char c = *p++;
		switch (c) {
		case '"':
			if (sb_append_n(sb, "\\\"", 2) != 0)
				return -1;
			break;
		case '\\':
			if (sb_append_n(sb, "\\\\", 2) != 0)
				return -1;
			break;
		case '\b':
			if (sb_append_n(sb, "\\b", 2) != 0)
				return -1;
			break;
		case '\f':
			if (sb_append_n(sb, "\\f", 2) != 0)
				return -1;
			break;
		case '\n':
			if (sb_append_n(sb, "\\n", 2) != 0)
				return -1;
			break;
		case '\r':
			if (sb_append_n(sb, "\\r", 2) != 0)
				return -1;
			break;
		case '\t':
			if (sb_append_n(sb, "\\t", 2) != 0)
				return -1;
			break;
		default:
			if (c < 0x20) {
				char esc[6] = {
					'\\', 'u', '0', '0',
					hex[(c >> 4) & 0x0f], hex[c & 0x0f]
				};
				if (sb_append_n(sb, esc, 6) != 0)
					return -1;
			} else {
				if (sb_append_n(sb, (const char *)&c, 1) != 0)
					return -1;
			}
			break;
		}
	}
	return sb_append_n(sb, "\"", 1);
}

static uint64_t now_monotonic_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int sandbox_interrupt(JSContext *ctx, void *opaque)
{
	SandboxState *st = (SandboxState *)opaque;
	(void)ctx;
	if (!st)
		return 0;
	if (now_monotonic_ns() >= st->deadline_ns) {
		st->timed_out = 1;
		return 1;
	}
	return 0;
}

static const char *const CONSOLE_LEVELS[6] = {
	"log", "info", "warn", "error", "debug", "trace"
};

static char *format_console_arg(JSContext *ctx, JSValueConst val, size_t *out_len)
{
	if (JS_IsString(val)) {
		size_t len = 0;
		const char *s = JS_ToCStringLen(ctx, &len, val);
		char *copy = s ? xstrndup(s, len) : xstrdup("");
		if (s)
			JS_FreeCString(ctx, s);
		*out_len = copy ? len : 0;
		return copy;
	}
	JSValue str = JS_JSONStringify(ctx, val, JS_UNDEFINED, JS_UNDEFINED);
	if (!JS_IsException(str) && JS_IsString(str)) {
		size_t len = 0;
		const char *s = JS_ToCStringLen(ctx, &len, str);
		char *copy = s ? xstrndup(s, len) : xstrdup("");
		if (s)
			JS_FreeCString(ctx, s);
		JS_FreeValue(ctx, str);
		*out_len = copy ? len : 0;
		return copy;
	}
	if (JS_IsException(str))
		JS_FreeValue(ctx, JS_GetException(ctx));
	JS_FreeValue(ctx, str);

	size_t len = 0;
	const char *s = JS_ToCStringLen(ctx, &len, val);
	if (s) {
		char *copy = xstrndup(s, len);
		JS_FreeCString(ctx, s);
		*out_len = copy ? len : 0;
		return copy;
	}
	if (JS_HasException(ctx))
		JS_FreeValue(ctx, JS_GetException(ctx));
	*out_len = 0;
	return xstrdup("");
}

static JSValue js_console_write(JSContext *ctx, JSValueConst this_val,
				int argc, JSValueConst *argv, int magic)
{
	SandboxState *st = (SandboxState *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
	(void)this_val;
	if (!st || !st->capture_logs || st->log_count >= FORGE_MAX_LOG_LINES)
		return JS_UNDEFINED;
	if (magic < 0 || magic >= 6)
		return JS_UNDEFINED;

	StrBuf text = {0};
	for (int i = 0; i < argc; i++) {
		size_t alen = 0;
		char *arg = format_console_arg(ctx, argv[i], &alen);
		if (!arg) {
			free(text.data);
			return JS_UNDEFINED;
		}
		if (i > 0 && sb_append_n(&text, " ", 1) != 0) {
			free(arg);
			free(text.data);
			return JS_UNDEFINED;
		}
		if (sb_append_n(&text, arg, alen) != 0) {
			free(arg);
			free(text.data);
			return JS_UNDEFINED;
		}
		free(arg);
	}
	if (!text.data && sb_append_n(&text, "", 0) != 0)
		return JS_UNDEFINED;

	if (st->log_bytes + text.len > FORGE_MAX_LOG_BYTES) {
		free(text.data);
		return JS_UNDEFINED;
	}

	const char *level = CONSOLE_LEVELS[magic];
	size_t full_len = strlen(level) + 2 + text.len;
	char *entry = (char *)malloc(full_len + 1);
	if (!entry) {
		free(text.data);
		return JS_UNDEFINED;
	}
	memcpy(entry, level, strlen(level));
	memcpy(entry + strlen(level), ": ", 2);
	memcpy(entry + strlen(level) + 2, text.data, text.len + 1);

	char **next = (char **)realloc(st->logs, (st->log_count + 1) * sizeof(char *));
	if (!next) {
		free(entry);
		free(text.data);
		return JS_UNDEFINED;
	}
	st->logs = next;
	st->logs[st->log_count++] = entry;
	st->log_bytes += text.len;
	free(text.data);
	return JS_UNDEFINED;
}

static int install_console(JSContext *ctx)
{
	JSValue console_obj = JS_NewObject(ctx);
	if (JS_IsException(console_obj))
		return -1;
	for (int i = 0; i < 6; i++) {
		JSValue fn = JS_NewCFunctionMagic(ctx, js_console_write,
						  CONSOLE_LEVELS[i], 0,
						  JS_CFUNC_generic_magic, i);
		if (JS_IsException(fn)) {
			JS_FreeValue(ctx, console_obj);
			return -1;
		}
		if (JS_SetPropertyStr(ctx, console_obj, CONSOLE_LEVELS[i], fn) < 0) {
			JS_FreeValue(ctx, console_obj);
			return -1;
		}
	}
	JSValue global = JS_GetGlobalObject(ctx);
	int rc = JS_SetPropertyStr(ctx, global, "console", console_obj);
	JS_FreeValue(ctx, global);
	return rc < 0 ? -1 : 0;
}

static char *trim_dup(const char *s)
{
	const char *start = s;
	const char *end;
	if (!s)
		return NULL;
	while (*start && isspace((unsigned char)*start))
		start++;
	end = start + strlen(start);
	while (end > start && isspace((unsigned char)end[-1]))
		end--;
	if (end == start)
		return NULL;
	return xstrndup(start, (size_t)(end - start));
}

static void set_failure(ForgeFailure *err, ForgeErrorKind kind,
			const char *message, const char *stack)
{
	err->kind = kind;
	free(err->message);
	free(err->stack);
	err->message = xstrdup(message ? message : "unknown error");
	err->stack = stack ? xstrdup(stack) : NULL;
}

static void classify_exception_val(JSContext *ctx, SandboxState *st,
				   JSValueConst exc, ForgeErrorKind phase,
				   ForgeFailure *err)
{
	if (st && st->timed_out) {
		set_failure(err, FORGE_ERR_TIMEOUT, "script timed out", NULL);
		return;
	}
	if (JS_IsNull(exc)) {
		set_failure(err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		return;
	}

	char *msg = NULL;
	char *stack = NULL;

	if (JS_IsObject(exc)) {
		JSValue m = JS_GetPropertyStr(ctx, exc, "message");
		if (JS_IsString(m)) {
			const char *cs = JS_ToCString(ctx, m);
			if (cs) {
				msg = xstrdup(cs);
				JS_FreeCString(ctx, cs);
			}
		}
		JS_FreeValue(ctx, m);

		JSValue s = JS_GetPropertyStr(ctx, exc, "stack");
		if (JS_IsString(s)) {
			const char *cs = JS_ToCString(ctx, s);
			if (cs) {
				stack = trim_dup(cs);
				JS_FreeCString(ctx, cs);
			}
		}
		JS_FreeValue(ctx, s);
	}

	if (!msg) {
		const char *cs = JS_ToCString(ctx, exc);
		if (cs) {
			msg = xstrdup(cs);
			JS_FreeCString(ctx, cs);
		} else {
			if (JS_HasException(ctx))
				JS_FreeValue(ctx, JS_GetException(ctx));
			msg = xstrdup("unknown error");
		}
	}

	if (strcmp(msg, "out of memory") == 0) {
		set_failure(err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
	} else {
		set_failure(err, phase, msg, stack);
	}
	free(msg);
	free(stack);
}

static void classify_pending_exception(JSContext *ctx, SandboxState *st,
				       ForgeErrorKind phase, ForgeFailure *err)
{
	JSValue exc = JS_GetException(ctx);
	classify_exception_val(ctx, st, exc, phase, err);
	JS_FreeValue(ctx, exc);
}

static int validate_tree(JSContext *ctx, JSValueConst val, size_t depth,
			 void **seen, ForgeErrorKind err_kind,
			 SandboxState *st, ForgeFailure *err)
{
	if (!JS_IsObject(val))
		return 0;
	if (depth > FORGE_MAX_DEPTH) {
		set_failure(err, err_kind, "a config nested within the depth limit", NULL);
		return -1;
	}
	void *ptr = JS_VALUE_GET_PTR(val);
	for (size_t i = 0; i < depth; i++) {
		if (seen[i] == ptr) {
			set_failure(err, err_kind, "circular reference in result", NULL);
			return -1;
		}
	}
	seen[depth] = ptr;

	if (JS_IsArray(val)) {
		int64_t len = 0;
		if (JS_GetLength(ctx, val, &len) < 0) {
			classify_pending_exception(ctx, st, err_kind, err);
			return -1;
		}
		for (int64_t i = 0; i < len; i++) {
			JSValue item = JS_GetPropertyInt64(ctx, val, i);
			if (JS_IsException(item)) {
				classify_pending_exception(ctx, st, err_kind, err);
				return -1;
			}
			int rc = 0;
			if (JS_IsObject(item) && !JS_IsFunction(ctx, item))
				rc = validate_tree(ctx, item, depth + 1, seen, err_kind, st, err);
			JS_FreeValue(ctx, item);
			if (rc != 0)
				return -1;
		}
		return 0;
	}

	JSPropertyEnum *props = NULL;
	uint32_t count = 0;
	if (JS_GetOwnPropertyNames(ctx, &props, &count, val,
				   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
		classify_pending_exception(ctx, st, err_kind, err);
		return -1;
	}
	for (uint32_t i = 0; i < count; i++) {
		JSValue v = JS_GetProperty(ctx, val, props[i].atom);
		if (JS_IsException(v)) {
			JS_FreePropertyEnum(ctx, props, count);
			classify_pending_exception(ctx, st, err_kind, err);
			return -1;
		}
		int rc = 0;
		if (JS_IsObject(v) && !JS_IsFunction(ctx, v))
			rc = validate_tree(ctx, v, depth + 1, seen, err_kind, st, err);
		JS_FreeValue(ctx, v);
		if (rc != 0) {
			JS_FreePropertyEnum(ctx, props, count);
			return -1;
		}
	}
	JS_FreePropertyEnum(ctx, props, count);
	return 0;
}

static int normalize_config(JSContext *ctx, SandboxState *st,
			    const char *config, size_t config_len,
			    JSValue *out_norm, char **out_fallback_json,
			    ForgeFailure *err)
{
	JSValue parsed = JS_ParseJSON(ctx, config, config_len, "<config>");
	if (JS_IsException(parsed)) {
		classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
		return -1;
	}
	if (!JS_IsObject(parsed) || JS_IsArray(parsed)) {
		JS_FreeValue(ctx, parsed);
		set_failure(err, FORGE_ERR_INVALID_INPUT, "profile is not a JSON object", NULL);
		return -1;
	}

	void *seen[FORGE_MAX_DEPTH + 1];
	if (validate_tree(ctx, parsed, 0, seen, FORGE_ERR_INVALID_INPUT, st, err) != 0) {
		JS_FreeValue(ctx, parsed);
		return -1;
	}

	JSValue norm = JS_NewObject(ctx);
	if (JS_IsException(norm)) {
		JS_FreeValue(ctx, parsed);
		classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
		return -1;
	}

	JSPropertyEnum *props = NULL;
	uint32_t count = 0;
	if (JS_GetOwnPropertyNames(ctx, &props, &count, parsed,
				   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
		JS_FreeValue(ctx, norm);
		JS_FreeValue(ctx, parsed);
		classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
		return -1;
	}

	for (uint32_t i = 0; i < count; i++) {
		const char *key = JS_AtomToCString(ctx, props[i].atom);
		if (!key) {
			JS_FreePropertyEnum(ctx, props, count);
			JS_FreeValue(ctx, norm);
			JS_FreeValue(ctx, parsed);
			classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
			return -1;
		}
		JSValue val = JS_GetProperty(ctx, parsed, props[i].atom);
		if (JS_IsException(val)) {
			JS_FreeCString(ctx, key);
			JS_FreePropertyEnum(ctx, props, count);
			JS_FreeValue(ctx, norm);
			JS_FreeValue(ctx, parsed);
			classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
			return -1;
		}
		const char *target = (strcmp(key, "rule") == 0) ? "rules" : key;
		int rc = JS_SetPropertyStr(ctx, norm, target, val);
		JS_FreeCString(ctx, key);
		if (rc < 0) {
			JS_FreePropertyEnum(ctx, props, count);
			JS_FreeValue(ctx, norm);
			JS_FreeValue(ctx, parsed);
			classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
			return -1;
		}
	}
	JS_FreePropertyEnum(ctx, props, count);
	JS_FreeValue(ctx, parsed);

	JSValue pp = JS_GetPropertyStr(ctx, norm, "proxy-providers");
	if (JS_IsException(pp)) {
		JS_FreeValue(ctx, norm);
		classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
		return -1;
	}
	if (JS_IsUndefined(pp) || JS_IsNull(pp)) {
		JSValue empty_obj = JS_NewObject(ctx);
		if (JS_IsException(empty_obj) ||
		    JS_SetPropertyStr(ctx, norm, "proxy-providers", empty_obj) < 0) {
			JS_FreeValue(ctx, pp);
			JS_FreeValue(ctx, norm);
			classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
			return -1;
		}
	}
	JS_FreeValue(ctx, pp);

	JSValue fallback = JS_JSONStringify(ctx, norm, JS_UNDEFINED, JS_UNDEFINED);
	if (JS_IsException(fallback) || !JS_IsString(fallback)) {
		JS_FreeValue(ctx, norm);
		if (JS_IsException(fallback))
			classify_pending_exception(ctx, st, FORGE_ERR_INVALID_INPUT, err);
		else
			set_failure(err, FORGE_ERR_INVALID_INPUT, "failed to serialize config", NULL);
		JS_FreeValue(ctx, fallback);
		return -1;
	}
	size_t fb_len = 0;
	const char *fb_c = JS_ToCStringLen(ctx, &fb_len, fallback);
	*out_fallback_json = fb_c ? xstrndup(fb_c, fb_len) : NULL;
	if (fb_c)
		JS_FreeCString(ctx, fb_c);
	JS_FreeValue(ctx, fallback);
	if (!*out_fallback_json) {
		JS_FreeValue(ctx, norm);
		set_failure(err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		return -1;
	}

	*out_norm = norm;
	return 0;
}

static int init_sandbox(ForgeLimits limits, int capture_logs,
			JSRuntime **out_rt, JSContext **out_ctx,
			SandboxState *st, ForgeFailure *err)
{
	memset(st, 0, sizeof(*st));
	st->deadline_ns = now_monotonic_ns() + limits.timeout_ms * 1000000ULL;
	st->capture_logs = capture_logs;

	JSRuntime *rt = JS_NewRuntime();
	if (!rt) {
		set_failure(err, FORGE_ERR_RUNTIME, "failed to create JS runtime", NULL);
		return -1;
	}
	JS_SetMemoryLimit(rt, limits.memory_limit);
	JS_SetMaxStackSize(rt, limits.stack_limit);
	JS_SetRuntimeOpaque(rt, st);
	JS_SetInterruptHandler(rt, sandbox_interrupt, st);

	JSContext *ctx = JS_NewContext(rt);
	if (!ctx) {
		JS_FreeRuntime(rt);
		set_failure(err, FORGE_ERR_RUNTIME, "failed to create JS context", NULL);
		return -1;
	}
	if (install_console(ctx) != 0) {
		classify_pending_exception(ctx, st, FORGE_ERR_RUNTIME, err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}
	*out_rt = rt;
	*out_ctx = ctx;
	return 0;
}

static void transfer_logs_to_failure(SandboxState *st, ForgeFailure *err)
{
	err->logs = st->logs;
	err->log_count = st->log_count;
	st->logs = NULL;
	st->log_count = 0;
}

static void free_logs_array(char **logs, size_t count)
{
	if (!logs)
		return;
	for (size_t i = 0; i < count; i++)
		free(logs[i]);
	free(logs);
}

int forge_run(const char *script, size_t script_len,
	      const char *config, size_t config_len,
	      const char *options_json, size_t options_len,
	      ForgeLimits limits,
	      ForgeResult *out_res, ForgeFailure *out_err)
{
	memset(out_res, 0, sizeof(*out_res));
	memset(out_err, 0, sizeof(*out_err));

	JSRuntime *rt = NULL;
	JSContext *ctx = NULL;
	SandboxState st;
	if (init_sandbox(limits, 1, &rt, &ctx, &st, out_err) != 0)
		return -1;

	JSValue norm_cfg = JS_UNDEFINED;
	char *fallback_json = NULL;
	if (normalize_config(ctx, &st, config, config_len,
			     &norm_cfg, &fallback_json, out_err) != 0) {
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	JSValue custom_val = JS_NULL;
	if (options_json) {
		custom_val = JS_ParseJSON(ctx, options_json, options_len, "<options>");
		if (JS_IsException(custom_val)) {
			classify_pending_exception(ctx, &st, FORGE_ERR_INVALID_INPUT, out_err);
			free(fallback_json);
			JS_FreeValue(ctx, norm_cfg);
			transfer_logs_to_failure(&st, out_err);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
			return -1;
		}
		void *seen[FORGE_MAX_DEPTH + 1];
		if (validate_tree(ctx, custom_val, 0, seen, FORGE_ERR_INVALID_INPUT, &st, out_err) != 0) {
			JS_FreeValue(ctx, custom_val);
			free(fallback_json);
			JS_FreeValue(ctx, norm_cfg);
			transfer_logs_to_failure(&st, out_err);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
			return -1;
		}
	}

	static const char prefix[] = "(function(__config, __custom) { ";
	static const char suffix[] =
		"\n;if (__custom && typeof ruleOptionsEnable !== 'undefined') "
		"Object.assign(ruleOptionsEnable, __custom);\n"
		"return main(__config, __custom); })";

	StrBuf wrapped = {0};
	if (sb_append_n(&wrapped, prefix, sizeof(prefix) - 1) != 0 ||
	    sb_append_n(&wrapped, script, script_len) != 0 ||
	    sb_append_n(&wrapped, suffix, sizeof(suffix) - 1) != 0) {
		free(wrapped.data);
		JS_FreeValue(ctx, custom_val);
		free(fallback_json);
		JS_FreeValue(ctx, norm_cfg);
		set_failure(out_err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	JSValue entry = JS_Eval(ctx, wrapped.data, wrapped.len, "<script>", JS_EVAL_TYPE_GLOBAL);
	free(wrapped.data);
	if (JS_IsException(entry)) {
		classify_pending_exception(ctx, &st, FORGE_ERR_SYNTAX, out_err);
		JS_FreeValue(ctx, custom_val);
		free(fallback_json);
		JS_FreeValue(ctx, norm_cfg);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	JSValue call_args[2] = { norm_cfg, custom_val };
	JSValue res = JS_Call(ctx, entry, JS_UNDEFINED, 2, call_args);
	JS_FreeValue(ctx, entry);
	JS_FreeValue(ctx, norm_cfg);
	JS_FreeValue(ctx, custom_val);

	if (JS_IsException(res)) {
		classify_pending_exception(ctx, &st, FORGE_ERR_RUNTIME, out_err);
		free(fallback_json);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	if (JS_IsPromise(res)) {
		JSContext *pctx = NULL;
		int job_rc;
		while ((job_rc = JS_ExecutePendingJob(rt, &pctx)) > 0) {
		}
		if (job_rc < 0) {
			classify_pending_exception(pctx ? pctx : ctx, &st, FORGE_ERR_RUNTIME, out_err);
			JS_FreeValue(ctx, res);
			free(fallback_json);
			transfer_logs_to_failure(&st, out_err);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
			return -1;
		}
		JSPromiseStateEnum pstate = JS_PromiseState(ctx, res);
		if (pstate == JS_PROMISE_FULFILLED) {
			JSValue resolved = JS_PromiseResult(ctx, res);
			JS_FreeValue(ctx, res);
			res = resolved;
		} else if (pstate == JS_PROMISE_REJECTED) {
			JSValue reason = JS_PromiseResult(ctx, res);
			JS_FreeValue(ctx, res);
			classify_exception_val(ctx, &st, reason, FORGE_ERR_RUNTIME, out_err);
			JS_FreeValue(ctx, reason);
			free(fallback_json);
			transfer_logs_to_failure(&st, out_err);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
			return -1;
		} else {
			JS_FreeValue(ctx, res);
			free(fallback_json);
			set_failure(out_err, FORGE_ERR_RUNTIME,
				    "main() returned a Promise that did not settle", NULL);
			transfer_logs_to_failure(&st, out_err);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
			return -1;
		}
	}

	if (!JS_IsObject(res) || JS_IsArray(res) || JS_IsFunction(ctx, res)) {
		JS_FreeValue(ctx, res);
		out_res->output_json = fallback_json;
		out_res->logs = st.logs;
		out_res->log_count = st.log_count;
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return 0;
	}
	free(fallback_json);

	void *seen[FORGE_MAX_DEPTH + 1];
	if (validate_tree(ctx, res, 0, seen, FORGE_ERR_INVALID_OUTPUT, &st, out_err) != 0) {
		JS_FreeValue(ctx, res);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	JSValue out_str = JS_JSONStringify(ctx, res, JS_UNDEFINED, JS_UNDEFINED);
	JS_FreeValue(ctx, res);
	if (JS_IsException(out_str)) {
		classify_pending_exception(ctx, &st, FORGE_ERR_INVALID_OUTPUT, out_err);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}
	if (!JS_IsString(out_str)) {
		JS_FreeValue(ctx, out_str);
		set_failure(out_err, FORGE_ERR_INVALID_OUTPUT,
			    "result cannot be serialized to JSON", NULL);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	size_t out_len = 0;
	const char *out_c = JS_ToCStringLen(ctx, &out_len, out_str);
	out_res->output_json = out_c ? xstrndup(out_c, out_len) : NULL;
	if (out_c)
		JS_FreeCString(ctx, out_c);
	JS_FreeValue(ctx, out_str);
	if (!out_res->output_json) {
		set_failure(out_err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		transfer_logs_to_failure(&st, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	out_res->logs = st.logs;
	out_res->log_count = st.log_count;
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);
	return 0;
}

int forge_extract_options(const char *script, size_t script_len,
			  ForgeLimits limits,
			  ForgeResult *out_res, ForgeFailure *out_err)
{
	memset(out_res, 0, sizeof(*out_res));
	memset(out_err, 0, sizeof(*out_err));

	JSRuntime *rt = NULL;
	JSContext *ctx = NULL;
	SandboxState st;
	if (init_sandbox(limits, 0, &rt, &ctx, &st, out_err) != 0)
		return -1;

	static const char prefix[] = "(function() { ";
	static const char suffix[] =
		"\n;var __options = typeof ruleOptionsEnable !== 'undefined' && ruleOptionsEnable && typeof ruleOptionsEnable === 'object' ? ruleOptionsEnable : {};\n"
		"var __icons = {};\n"
		"if (typeof serviceConfigs !== 'undefined' && Array.isArray(serviceConfigs)) {\n"
		"  for (var __i = 0; __i < serviceConfigs.length; __i++) {\n"
		"    var __service = serviceConfigs[__i];\n"
		"    if (__service && __service.name && typeof __service.icon === 'string') {\n"
		"      __icons[__service.name] = __service.icon;\n"
		"    }\n"
		"  }\n"
		"}\n"
		"var __groups = [];\n"
		"if (typeof Compatible_With_Bettbox !== 'undefined' && Compatible_With_Bettbox && Array.isArray(Compatible_With_Bettbox.policyGroupOptions)) {\n"
		"  var __declared = Compatible_With_Bettbox.policyGroupOptions;\n"
		"  for (var __j = 0; __j < __declared.length; __j++) {\n"
		"    if (typeof __declared[__j] === 'string') {\n"
		"      __groups.push(__declared[__j]);\n"
		"    }\n"
		"  }\n"
		"}\n"
		"var __result = { options: __options, icons: __icons, policyGroupOptions: __groups };\n"
		"if (typeof Compatible_With_Bettbox !== 'undefined' && Compatible_With_Bettbox && Compatible_With_Bettbox.nodeRegions && typeof Compatible_With_Bettbox.nodeRegions === 'object') {\n"
		"  __result.nodeRegions = Compatible_With_Bettbox.nodeRegions;\n"
		"}\n"
		"return JSON.stringify(__result);\n"
		"})()";

	StrBuf wrapped = {0};
	if (sb_append_n(&wrapped, prefix, sizeof(prefix) - 1) != 0 ||
	    sb_append_n(&wrapped, script, script_len) != 0 ||
	    sb_append_n(&wrapped, suffix, sizeof(suffix) - 1) != 0) {
		free(wrapped.data);
		set_failure(out_err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	JSValue res = JS_Eval(ctx, wrapped.data, wrapped.len, "<script>", JS_EVAL_TYPE_GLOBAL);
	free(wrapped.data);
	if (JS_IsException(res)) {
		classify_pending_exception(ctx, &st, FORGE_ERR_RUNTIME, out_err);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}
	if (!JS_IsString(res)) {
		JS_FreeValue(ctx, res);
		set_failure(out_err, FORGE_ERR_INVALID_OUTPUT,
			    "script options are not available", NULL);
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return -1;
	}

	size_t out_len = 0;
	const char *out_c = JS_ToCStringLen(ctx, &out_len, res);
	out_res->output_json = out_c ? xstrndup(out_c, out_len) : NULL;
	if (out_c)
		JS_FreeCString(ctx, out_c);
	JS_FreeValue(ctx, res);
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);
	if (!out_res->output_json) {
		set_failure(out_err, FORGE_ERR_OUT_OF_MEMORY, "script ran out of memory", NULL);
		return -1;
	}
	return 0;
}

const char *forge_error_kind_str(ForgeErrorKind kind)
{
	switch (kind) {
	case FORGE_ERR_SYNTAX:         return "Syntax";
	case FORGE_ERR_RUNTIME:        return "Runtime";
	case FORGE_ERR_TIMEOUT:        return "Timeout";
	case FORGE_ERR_OUT_OF_MEMORY:  return "OutOfMemory";
	case FORGE_ERR_CANCELLED:      return "Cancelled";
	case FORGE_ERR_INVALID_INPUT:  return "InvalidInput";
	case FORGE_ERR_INVALID_OUTPUT: return "InvalidOutput";
	default:                       return "Runtime";
	}
}

char *forge_format_logs_json(char *const *logs, size_t count)
{
	StrBuf sb = {0};
	if (sb_append_n(&sb, "[", 1) != 0)
		return NULL;
	for (size_t i = 0; i < count; i++) {
		if (i > 0 && sb_append_n(&sb, ",", 1) != 0) {
			free(sb.data);
			return NULL;
		}
		if (sb_append_json_str(&sb, logs[i]) != 0) {
			free(sb.data);
			return NULL;
		}
	}
	if (sb_append_n(&sb, "]", 1) != 0) {
		free(sb.data);
		return NULL;
	}
	return sb.data;
}

char *forge_format_failure_json(const ForgeFailure *err)
{
	StrBuf sb = {0};
	char *logs_json = forge_format_logs_json(err->logs, err->log_count);
	if (!logs_json)
		return NULL;

	int ok = sb_append(&sb, "{\"error\":{\"kind\":") == 0 &&
		 sb_append_json_str(&sb, forge_error_kind_str(err->kind)) == 0 &&
		 sb_append(&sb, ",\"message\":") == 0 &&
		 sb_append_json_str(&sb, err->message ? err->message : "") == 0 &&
		 sb_append(&sb, ",\"stack\":") == 0 &&
		 (err->stack ? sb_append_json_str(&sb, err->stack) : sb_append(&sb, "null")) == 0 &&
		 sb_append(&sb, ",\"logs\":") == 0 &&
		 sb_append(&sb, logs_json) == 0 &&
		 sb_append(&sb, "}}") == 0;

	free(logs_json);
	if (!ok) {
		free(sb.data);
		return NULL;
	}
	return sb.data;
}

void forge_result_free(ForgeResult *res)
{
	if (!res)
		return;
	free(res->output_json);
	free_logs_array(res->logs, res->log_count);
	memset(res, 0, sizeof(*res));
}

void forge_failure_free(ForgeFailure *err)
{
	if (!err)
		return;
	free(err->message);
	free(err->stack);
	free_logs_array(err->logs, err->log_count);
	memset(err, 0, sizeof(*err));
}
