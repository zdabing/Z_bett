#!/usr/bin/env node
'use strict';

/**
 * Verifies that every LuCI frontend JS file under luci-app-bettbox/htdocs
 * survives OpenWrt 25.12's C jsmin minifier (modules/luci-base/src/jsmin.c)
 * without regex desynchronization or SyntaxError under LuCI's module loader.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'luci-app-bettbox', 'htdocs');
const REGEX_PRECEDERS = new Set([
	'(', ',', '=', ':', '[', '!', '&', '|', '?', '+', '-', '~', '*', '/', '{', '}', ';'
].map(function (ch) { return ch.charCodeAt(0); }));
const KEYWORD_SLASH_RE = /(?<![.\w$])\b(return|throw|case|in|of|typeof|void|delete|yield|await|else|do)\//;

function isAlphanum(c) {
	return (c >= 97 && c <= 122) ||
		(c >= 48 && c <= 57) ||
		(c >= 65 && c <= 90) ||
		c === 95 || c === 36 || c === 92 || c > 126;
}

function jsmin(src, file) {
	const buf = Buffer.from(src, 'utf8');
	const out = [];
	let pos = 0;
	let lookAhead = -1;
	let theA = 0;
	let theB = 0;
	let theX = -1;
	let theY = -1;

	function get() {
		let c = lookAhead;
		lookAhead = -1;
		if (c === -1) c = pos < buf.length ? buf[pos++] : -1;
		if (c >= 32 || c === 10 || c === -1) return c;
		if (c === 13) return 10;
		return 32;
	}

	function peek() {
		lookAhead = get();
		return lookAhead;
	}

	function next() {
		let c = get();
		if (c === 47) {
			const p = peek();
			if (p === 47) {
				for (;;) {
					c = get();
					if (c <= 10) break;
				}
			} else if (p === 42) {
				get();
				while (c !== 32) {
					const g = get();
					if (g === 42) {
						if (peek() === 47) {
							get();
							c = 32;
						}
					} else if (g === -1) {
						throw new Error('JSMIN Error: Unterminated comment.');
					}
				}
			}
		}
		theY = theX;
		theX = c;
		return c;
	}

	function action(determined) {
		if (determined <= 1) {
			out.push(theA);
			if (
				(theY === 10 || theY === 32) &&
				(theA === 43 || theA === 45 || theA === 42 || theA === 47) &&
				(theB === 43 || theB === 45 || theB === 42 || theB === 47)
			) {
				out.push(theY);
			}
		}
		if (determined <= 2) {
			theA = theB;
			if (theA === 39 || theA === 34 || theA === 96) {
				for (;;) {
					out.push(theA);
					theA = get();
					if (theA === theB) break;
					if (theA === 92) {
						out.push(theA);
						theA = get();
					}
					if (theA === -1) {
						throw new Error('JSMIN Error: Unterminated string literal.');
					}
				}
			}
		}
		if (determined <= 3) {
			theB = next();
			if (theB === 47 && REGEX_PRECEDERS.has(theA)) {
				out.push(theA);
				if (theA === 47 || theA === 42) out.push(32);
				out.push(theB);
				let body = '';
				for (;;) {
					theA = get();
					if (theA === 91) {
						for (;;) {
							body += String.fromCharCode(theA);
							out.push(theA);
							theA = get();
							if (theA === 93) break;
							if (theA === 92) {
								body += String.fromCharCode(theA);
								out.push(theA);
								theA = get();
							}
							if (theA === -1) {
								throw new Error('JSMIN Error: Unterminated set in Regular Expression literal.');
							}
						}
					} else if (theA === 47) {
						const p = peek();
						if (p === 47 || p === 42) {
							throw new Error('JSMIN Error: Unterminated set in Regular Expression literal.');
						}
						break;
					} else if (theA === 92) {
						body += String.fromCharCode(theA);
						out.push(theA);
						theA = get();
					}
					if (theA === -1) {
						throw new Error('JSMIN Error: Unterminated Regular Expression literal.');
					}
					body += String.fromCharCode(theA);
					out.push(theA);
				}
				if (body.indexOf('\n') !== -1) {
					throw new Error('JSMIN Error: Multiline regex literal detected in ' + file + ': ' + JSON.stringify(body.slice(0, 80)));
				}
				theB = next();
			}
		}
	}

	if (peek() === 0xEF) {
		get();
		get();
		get();
	}
	theA = 10;
	action(3);
	while (theA !== -1) {
		if (theA === 32) {
			action(isAlphanum(theB) ? 1 : 2);
		} else if (theA === 10) {
			if (theB === 123 || theB === 91 || theB === 40 || theB === 43 || theB === 45 || theB === 33 || theB === 126) {
				action(1);
			} else if (theB === 32) {
				action(3);
			} else {
				action(isAlphanum(theB) ? 1 : 2);
			}
		} else {
			if (theB === 32) {
				action(isAlphanum(theA) ? 1 : 3);
			} else if (theB === 10) {
				if (theA === 125 || theA === 93 || theA === 41 || theA === 43 || theA === 45 || theA === 34 || theA === 39 || theA === 96) {
					action(1);
				} else {
					action(isAlphanum(theA) ? 1 : 3);
				}
			} else {
				action(1);
			}
		}
	}
	return Buffer.from(out).toString('utf8');
}

function walkJs(dir) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push.apply(files, walkJs(full));
		} else if (entry.name.endsWith('.js')) {
			files.push(full);
		}
	}
	return files.sort();
}

const files = walkJs(ROOT);
let failures = 0;

for (const file of files) {
	const rel = path.relative(path.resolve(__dirname, '..', '..'), file);
	try {
		const src = fs.readFileSync(file, 'utf8');
		const min = jsmin(src, rel);
		const kwMatch = min.match(KEYWORD_SLASH_RE);
		if (kwMatch) {
			throw new Error('Keyword followed by "/" in minified output ("' + kwMatch[0] + '") — wrap regex in () or assign to a variable for jsmin');
		}
		// LuCI's require loader wraps each resource in `new Function(...)`.
		new Function(min);
	} catch (err) {
		failures++;
		console.error('FAIL:', rel, '-', err.message);
	}
}

if (failures > 0) {
	process.exit(1);
}
console.log('PASS: ' + files.length + ' LuCI JS files passed jsmin + Function parse');
