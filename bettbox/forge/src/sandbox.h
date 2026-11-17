/* SPDX-License-Identifier: GPL-3.0 */
#ifndef BETTBOX_FORGE_SANDBOX_H
#define BETTBOX_FORGE_SANDBOX_H

#include <stddef.h>
#include <stdint.h>

#define FORGE_EVAL_TIMEOUT_DEFAULT_MS 10000ULL
#define FORGE_EVAL_TIMEOUT_MAX_MS     60000ULL
#define FORGE_EVAL_MEMORY_LIMIT       (128U * 1024U * 1024U)
#define FORGE_EVAL_STACK_LIMIT        (512U * 1024U)

#define FORGE_OPT_TIMEOUT_MS          2000ULL
#define FORGE_OPT_MEMORY_LIMIT        (32U * 1024U * 1024U)
#define FORGE_OPT_STACK_LIMIT         (512U * 1024U)

typedef enum {
	FORGE_ERR_NONE = 0,
	FORGE_ERR_SYNTAX,
	FORGE_ERR_RUNTIME,
	FORGE_ERR_TIMEOUT,
	FORGE_ERR_OUT_OF_MEMORY,
	FORGE_ERR_CANCELLED,
	FORGE_ERR_INVALID_INPUT,
	FORGE_ERR_INVALID_OUTPUT
} ForgeErrorKind;

typedef struct {
	uint64_t timeout_ms;
	size_t memory_limit;
	size_t stack_limit;
} ForgeLimits;

typedef struct {
	ForgeErrorKind kind;
	char *message;
	char *stack;
	char **logs;
	size_t log_count;
} ForgeFailure;

typedef struct {
	char *output_json;
	char **logs;
	size_t log_count;
} ForgeResult;

const char *forge_error_kind_str(ForgeErrorKind kind);

int forge_run(const char *script, size_t script_len,
	      const char *config, size_t config_len,
	      const char *options_json, size_t options_len,
	      ForgeLimits limits,
	      ForgeResult *out_res, ForgeFailure *out_err);

int forge_extract_options(const char *script, size_t script_len,
			  ForgeLimits limits,
			  ForgeResult *out_res, ForgeFailure *out_err);

void forge_result_free(ForgeResult *res);
void forge_failure_free(ForgeFailure *err);
char *forge_format_logs_json(char *const *logs, size_t count);
char *forge_format_failure_json(const ForgeFailure *err);

#endif
