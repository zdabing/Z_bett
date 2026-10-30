#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
// Serialize untrusted subscription text as data for the sandbox, never as JS.
import { readfile, writefile, stat } from 'fs';
if (length(ARGV) != 2) die('usage: subscription-input.uc <input> <output>\n');
let size = stat(ARGV[0])?.size;
if (size == null || size < 1 || size > 4194304) die('订阅内容为空或超过 4 MiB 上限\n');
let content = readfile(ARGV[0]);
if (content == null) die('无法读取订阅内容\n');
if (!writefile(ARGV[1], sprintf('%J', { content: content }))) die('无法准备订阅解析输入\n');
