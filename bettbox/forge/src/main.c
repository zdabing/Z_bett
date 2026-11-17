/* SPDX-License-Identifier: GPL-3.0 */
#include "sandbox.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef BETTBOX_FORGE_VERSION
#define BETTBOX_FORGE_VERSION "1.19.8"
#endif

typedef enum {
	MODE_NONE = 0,
	MODE_VERSION,
	MODE_RUN,
	MODE_OPTIONS
} ForgeMode;

typedef struct {
	ForgeMode mode;
	const char *script;
	const char *config;
	const char *options;
	const char *out;
	int has_timeout;
	uint64_t timeout_ms;
} ForgeArgs;

static void print_usage(void)
{
	fprintf(stderr,
		"usage: bettbox-forge run --script FILE --config FILE [--options JSON] [--timeout SECS] [--out FILE]\n"
		"       bettbox-forge options --script FILE [--out FILE]\n"
		"       bettbox-forge version\n");
}

static void emit_stderr_error(ForgeErrorKind kind, const char *message)
{
	ForgeFailure err = {0};
	err.kind = kind;
	err.message = (char *)(message ? message : "unknown error");
	char *json = forge_format_failure_json(&err);
	fprintf(stderr, "%s\n", json ? json : "{}");
	free(json);
}

static const char *take_flag_value(int argc, char **argv, int *idx)
{
	if (*idx + 1 >= argc)
		return NULL;
	if (strncmp(argv[*idx + 1], "--", 2) == 0)
		return NULL;
	(*idx)++;
	return argv[*idx];
}

static int parse_u64_strict(const char *s, uint64_t *out)
{
	if (!s || !*s)
		return -1;
	for (const char *p = s; *p; p++) {
		if (*p < '0' || *p > '9')
			return -1;
	}
	errno = 0;
	char *end = NULL;
	unsigned long long v = strtoull(s, &end, 10);
	if (errno != 0 || !end || *end != '\0')
		return -1;
	*out = (uint64_t)v;
	return 0;
}

static int parse_args(int argc, char **argv, ForgeArgs *args)
{
	memset(args, 0, sizeof(*args));
	if (argc < 2)
		return -1;

	if (strcmp(argv[1], "version") == 0) {
		args->mode = MODE_VERSION;
		return 0;
	} else if (strcmp(argv[1], "run") == 0) {
		args->mode = MODE_RUN;
	} else if (strcmp(argv[1], "options") == 0) {
		args->mode = MODE_OPTIONS;
	} else {
		return -1;
	}

	for (int i = 2; i < argc; i++) {
		const char *flag = argv[i];
		if (strcmp(flag, "--script") == 0) {
			args->script = take_flag_value(argc, argv, &i);
		} else if (strcmp(flag, "--config") == 0) {
			args->config = take_flag_value(argc, argv, &i);
		} else if (strcmp(flag, "--options") == 0) {
			args->options = take_flag_value(argc, argv, &i);
		} else if (strcmp(flag, "--timeout") == 0) {
			const char *v = take_flag_value(argc, argv, &i);
			uint64_t secs = 0;
			if (v && parse_u64_strict(v, &secs) == 0) {
				uint64_t ms = secs > (FORGE_EVAL_TIMEOUT_MAX_MS / 1000ULL)
					? FORGE_EVAL_TIMEOUT_MAX_MS
					: secs * 1000ULL;
				args->has_timeout = 1;
				args->timeout_ms = ms;
			}
		} else if (strcmp(flag, "--out") == 0) {
			args->out = take_flag_value(argc, argv, &i);
		} else {
			return -1;
		}
	}
	return 0;
}

static char *read_file_all(const char *path, size_t *out_len)
{
	FILE *fp = fopen(path, "rb");
	if (!fp)
		return NULL;

	size_t cap = 4096;
	size_t len = 0;
	char *buf = (char *)malloc(cap);
	if (!buf) {
		fclose(fp);
		return NULL;
	}

	for (;;) {
		if (len + 1 >= cap) {
			if (cap > (SIZE_MAX / 2)) {
				free(buf);
				fclose(fp);
				errno = ENOMEM;
				return NULL;
			}
			size_t next_cap = cap * 2;
			char *next = (char *)realloc(buf, next_cap);
			if (!next) {
				free(buf);
				fclose(fp);
				errno = ENOMEM;
				return NULL;
			}
			buf = next;
			cap = next_cap;
		}
		size_t got = fread(buf + len, 1, cap - len - 1, fp);
		len += got;
		if (got == 0) {
			if (ferror(fp)) {
				int saved = errno;
				free(buf);
				fclose(fp);
				errno = saved ? saved : EIO;
				return NULL;
			}
			break;
		}
	}

	fclose(fp);
	buf[len] = '\0';
	*out_len = len;
	return buf;
}

static int write_file_all(const char *path, const char *data, size_t len)
{
	FILE *fp = fopen(path, "wb");
	if (!fp)
		return -1;
	size_t off = 0;
	while (off < len) {
		size_t n = fwrite(data + off, 1, len - off, fp);
		if (n == 0) {
			int saved = errno;
			fclose(fp);
			errno = saved ? saved : EIO;
			return -1;
		}
		off += n;
	}
	if (fclose(fp) != 0)
		return -1;
	return 0;
}

int main(int argc, char **argv)
{
	ForgeArgs args;
	if (parse_args(argc, argv, &args) != 0) {
		print_usage();
		return 2;
	}

	if (args.mode == MODE_VERSION) {
		printf("%s\n", BETTBOX_FORGE_VERSION);
		return 0;
	}

	if (!args.script) {
		emit_stderr_error(FORGE_ERR_INVALID_INPUT, "--script is required");
		return 2;
	}

	size_t script_len = 0;
	char *script = read_file_all(args.script, &script_len);
	if (!script) {
		char msg[1024];
		snprintf(msg, sizeof(msg), "cannot read script %s: %s",
			 args.script, strerror(errno));
		emit_stderr_error(FORGE_ERR_INVALID_INPUT, msg);
		return 2;
	}

	ForgeResult res = {0};
	ForgeFailure err = {0};
	int rc;

	if (args.mode == MODE_RUN) {
		if (!args.config) {
			free(script);
			emit_stderr_error(FORGE_ERR_INVALID_INPUT, "--config is required");
			return 2;
		}
		size_t config_len = 0;
		char *config = read_file_all(args.config, &config_len);
		if (!config) {
			char msg[1024];
			snprintf(msg, sizeof(msg), "cannot read config %s: %s",
				 args.config, strerror(errno));
			free(script);
			emit_stderr_error(FORGE_ERR_INVALID_INPUT, msg);
			return 2;
		}
		ForgeLimits limits = {
			.timeout_ms = args.has_timeout ? args.timeout_ms : FORGE_EVAL_TIMEOUT_DEFAULT_MS,
			.memory_limit = FORGE_EVAL_MEMORY_LIMIT,
			.stack_limit = FORGE_EVAL_STACK_LIMIT
		};
		rc = forge_run(script, script_len, config, config_len,
			       args.options, args.options ? strlen(args.options) : 0,
			       limits, &res, &err);
		free(config);
	} else {
		ForgeLimits limits = {
			.timeout_ms = FORGE_OPT_TIMEOUT_MS,
			.memory_limit = FORGE_OPT_MEMORY_LIMIT,
			.stack_limit = FORGE_OPT_STACK_LIMIT
		};
		rc = forge_extract_options(script, script_len, limits, &res, &err);
	}

	free(script);

	if (rc == 0) {
		char *logs_json = forge_format_logs_json(res.logs, res.log_count);
		fprintf(stderr, "{\"logs\":%s}\n", logs_json ? logs_json : "[]");
		free(logs_json);

		size_t out_len = res.output_json ? strlen(res.output_json) : 0;
		if (args.out) {
			if (write_file_all(args.out, res.output_json ? res.output_json : "", out_len) != 0) {
				char msg[1024];
				snprintf(msg, sizeof(msg), "cannot write %s: %s",
					 args.out, strerror(errno));
				forge_result_free(&res);
				emit_stderr_error(FORGE_ERR_INVALID_OUTPUT, msg);
				return 2;
			}
		} else {
			printf("%s\n", res.output_json ? res.output_json : "");
		}
		forge_result_free(&res);
		return 0;
	}

	int code = (err.kind == FORGE_ERR_TIMEOUT) ? 124 : 1;
	char *fail_json = forge_format_failure_json(&err);
	fprintf(stderr, "%s\n", fail_json ? fail_json : "{}");
	free(fail_json);
	forge_failure_free(&err);
	return code;
}
