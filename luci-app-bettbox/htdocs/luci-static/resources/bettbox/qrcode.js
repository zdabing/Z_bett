'use strict';
'require baseclass';

/* Self-contained ISO/IEC 18004 QR Code SVG generator (Byte mode, EC Level L, Versions 1-20). */

var ALIGN = [
	[],
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
	[6, 26, 48, 70],
	[6, 26, 50, 74],
	[6, 30, 54, 78],
	[6, 30, 56, 82],
	[6, 30, 58, 86],
	[6, 34, 62, 90]
];

/* [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] for Level L */
var EC_TABLE = [
	null,
	[7, 1, 19, 0, 0],
	[10, 1, 34, 0, 0],
	[15, 1, 55, 0, 0],
	[20, 1, 80, 0, 0],
	[26, 1, 108, 0, 0],
	[18, 2, 68, 0, 0],
	[20, 2, 78, 0, 0],
	[24, 2, 97, 0, 0],
	[30, 2, 116, 0, 0],
	[18, 2, 68, 2, 69],
	[20, 4, 81, 0, 0],
	[24, 2, 92, 2, 93],
	[26, 4, 107, 0, 0],
	[30, 3, 115, 1, 116],
	[22, 5, 87, 1, 88],
	[24, 5, 98, 1, 99],
	[28, 1, 107, 5, 108],
	[30, 5, 120, 1, 121],
	[28, 3, 113, 4, 114],
	[28, 3, 107, 5, 108]
];

var GF_EXP = new Uint8Array(512);
var GF_LOG = new Uint8Array(256);
(function initGF() {
	var x = 1;
	for (var i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_EXP[i + 255] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
})();

function gfMul(a, b) {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
	var poly = new Uint8Array(degree + 1);
	poly[0] = 1;
	for (var i = 0; i < degree; i++) {
		var factor = GF_EXP[i];
		for (var j = i + 1; j > 0; j--) {
			poly[j] = poly[j] ^ gfMul(poly[j - 1], factor);
		}
	}
	return poly;
}

function rsCompute(data, ecCount) {
	var gen = rsGeneratorPoly(ecCount);
	var rem = new Uint8Array(ecCount);
	for (var i = 0; i < data.length; i++) {
		var factor = data[i] ^ rem[0];
		for (var j = 0; j < ecCount - 1; j++) rem[j] = rem[j + 1];
		rem[ecCount - 1] = 0;
		if (factor !== 0) {
			for (var k = 0; k < ecCount; k++) {
				rem[k] ^= gfMul(gen[k + 1], factor);
			}
		}
	}
	return rem;
}

function utf8Bytes(str) {
	if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
	var utf8 = unescape(encodeURIComponent(str));
	var out = new Uint8Array(utf8.length);
	for (var i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
	return out;
}

function dataCapacity(version) {
	var spec = EC_TABLE[version];
	return spec[1] * spec[2] + spec[3] * spec[4];
}

function chooseVersion(byteLen) {
	for (var v = 1; v <= 20; v++) {
		var headerBits = 4 + (v <= 9 ? 8 : 16);
		var totalBits = dataCapacity(v) * 8;
		if (headerBits + byteLen * 8 <= totalBits) return v;
	}
	return 0;
}

function encodeDataCodewords(bytes, version) {
	var cap = dataCapacity(version);
	var bits = [];
	function pushBits(val, count) {
		for (var i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
	}
	pushBits(0x4, 4);
	pushBits(bytes.length, version <= 9 ? 8 : 16);
	for (var i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);
	var maxBits = cap * 8;
	var term = Math.min(4, maxBits - bits.length);
	for (var t = 0; t < term; t++) bits.push(0);
	while (bits.length % 8 !== 0) bits.push(0);
	var codewords = new Uint8Array(cap);
	var idx = 0;
	for (var b = 0; b < bits.length; b += 8) {
		var byteVal = 0;
		for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bits[b + k];
		codewords[idx++] = byteVal;
	}
	var pad = [0xec, 0x11], p = 0;
	while (idx < cap) {
		codewords[idx++] = pad[p];
		p ^= 1;
	}
	return codewords;
}

function buildFinalBytes(codewords, version) {
	var spec = EC_TABLE[version];
	var ecLen = spec[0], g1 = spec[1], g1Data = spec[2], g2 = spec[3], g2Data = spec[4];
	var dataBlocks = [], ecBlocks = [], offset = 0, i;
	for (i = 0; i < g1; i++) {
		var blk1 = codewords.subarray(offset, offset + g1Data);
		offset += g1Data;
		dataBlocks.push(blk1);
		ecBlocks.push(rsCompute(blk1, ecLen));
	}
	for (i = 0; i < g2; i++) {
		var blk2 = codewords.subarray(offset, offset + g2Data);
		offset += g2Data;
		dataBlocks.push(blk2);
		ecBlocks.push(rsCompute(blk2, ecLen));
	}
	var out = [];
	var maxData = Math.max(g1Data, g2Data);
	for (i = 0; i < maxData; i++) {
		for (var b = 0; b < dataBlocks.length; b++) {
			if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
		}
	}
	for (i = 0; i < ecLen; i++) {
		for (var e = 0; e < ecBlocks.length; e++) out.push(ecBlocks[e][i]);
	}
	return out;
}

function bchFormat(mask) {
	var data = (1 << 3) | mask; /* EC Level L = 01 */
	var d = data << 10;
	for (var i = 4; i >= 0; i--) {
		if ((d >> (i + 10)) & 1) d ^= 0x537 << i;
	}
	return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version) {
	var d = version << 12;
	for (var i = 5; i >= 0; i--) {
		if ((d >> (i + 12)) & 1) d ^= 0x1f25 << i;
	}
	return (version << 12) | d;
}

function createTemplate(version) {
	var size = 17 + 4 * version;
	var modules = [];
	var fixed = [];
	for (var r = 0; r < size; r++) {
		modules.push(new Uint8Array(size));
		fixed.push(new Uint8Array(size));
	}
	function setFixed(row, col, val) {
		if (row >= 0 && row < size && col >= 0 && col < size) {
			modules[row][col] = val ? 1 : 0;
			fixed[row][col] = 1;
		}
	}
	function drawFinder(top, left) {
		for (var r = -1; r <= 7; r++) {
			for (var c = -1; c <= 7; c++) {
				var on = (r >= 0 && r <= 6 && c >= 0 && c <= 6) &&
					(r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
				setFixed(top + r, left + c, on);
			}
		}
	}
	function drawAlign(cr, cc) {
		for (var r = -2; r <= 2; r++) {
			for (var c = -2; c <= 2; c++) {
				var on = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
				setFixed(cr + r, cc + c, on);
			}
		}
	}
	drawFinder(0, 0);
	drawFinder(0, size - 7);
	drawFinder(size - 7, 0);
	for (var i = 8; i < size - 8; i++) {
		setFixed(6, i, (i & 1) === 0);
		setFixed(i, 6, (i & 1) === 0);
	}
	var centers = ALIGN[version];
	for (var a = 0; a < centers.length; a++) {
		for (var b = 0; b < centers.length; b++) {
			var ar = centers[a], ac = centers[b];
			if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
			drawAlign(ar, ac);
		}
	}
	setFixed(4 * version + 9, 8, 1);
	for (var k = 0; k < 9; k++) {
		if (k !== 6) {
			fixed[8][k] = 1;
			fixed[k][8] = 1;
		}
	}
	for (var m = 0; m < 8; m++) {
		fixed[8][size - 1 - m] = 1;
		if (m < 7) fixed[size - 1 - m][8] = 1;
	}
	if (version >= 7) {
		var verBits = bchVersion(version);
		for (var idx = 0; idx < 18; idx++) {
			var bit = (verBits >> idx) & 1;
			var p = Math.floor(idx / 3), q = size - 11 + (idx % 3);
			setFixed(p, q, bit);
			setFixed(q, p, bit);
		}
	}
	return { size: size, modules: modules, fixed: fixed };
}

function maskBit(mask, r, c) {
	switch (mask) {
	case 0: return ((r + c) % 2) === 0;
	case 1: return (r % 2) === 0;
	case 2: return (c % 3) === 0;
	case 3: return ((r + c) % 3) === 0;
	case 4: return ((Math.floor(r / 2) + Math.floor(c / 3)) % 2) === 0;
	case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
	case 6: return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
	case 7: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
	default: return false;
	}
}

function applyFormat(modules, size, mask) {
	var fmt = bchFormat(mask);
	for (var i = 0; i < 15; i++) {
		var bit = (fmt >> i) & 1;
		if (i < 6) modules[i][8] = bit;
		else if (i < 8) modules[i + 1][8] = bit;
		else modules[size - 15 + i][8] = bit;

		if (i < 8) modules[8][size - 1 - i] = bit;
		else if (i < 9) modules[8][15 - i] = bit;
		else modules[8][14 - i] = bit;
	}
}

function penalty(modules, size) {
	var score = 0, r, c, run, prev, cur;
	for (r = 0; r < size; r++) {
		run = 0; prev = -1;
		for (c = 0; c < size; c++) {
			cur = modules[r][c];
			if (cur === prev) {
				run++;
				if (run === 5) score += 3;
				else if (run > 5) score += 1;
			} else {
				prev = cur; run = 1;
			}
		}
	}
	for (c = 0; c < size; c++) {
		run = 0; prev = -1;
		for (r = 0; r < size; r++) {
			cur = modules[r][c];
			if (cur === prev) {
				run++;
				if (run === 5) score += 3;
				else if (run > 5) score += 1;
			} else {
				prev = cur; run = 1;
			}
		}
	}
	for (r = 0; r < size - 1; r++) {
		for (c = 0; c < size - 1; c++) {
			var v = modules[r][c];
			if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
		}
	}
	function finderMatch(arr) {
		var hits = 0;
		for (var i = 0; i <= arr.length - 11; i++) {
			if ((arr[i] && !arr[i + 1] && arr[i + 2] && arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] && !arr[i + 7] && !arr[i + 8] && !arr[i + 9] && !arr[i + 10]) ||
				(!arr[i] && !arr[i + 1] && !arr[i + 2] && !arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] && arr[i + 7] && arr[i + 8] && !arr[i + 9] && arr[i + 10]))
				hits += 40;
		}
		return hits;
	}
	var col = new Uint8Array(size);
	for (r = 0; r < size; r++) score += finderMatch(modules[r]);
	for (c = 0; c < size; c++) {
		for (r = 0; r < size; r++) col[r] = modules[r][c];
		score += finderMatch(col);
	}
	var dark = 0;
	for (r = 0; r < size; r++) {
		for (c = 0; c < size; c++) dark += modules[r][c];
	}
	var pct = (dark * 100) / (size * size);
	score += Math.min(Math.floor(Math.abs(pct - 50) / 5), 10) * 10;
	return score;
}

function matrix(text) {
	var bytes = utf8Bytes(String(text || ''));
	if (!bytes.length) return null;
	var version = chooseVersion(bytes.length);
	if (!version) return null;
	var tpl = createTemplate(version);
	var size = tpl.size, fixed = tpl.fixed;
	var stream = buildFinalBytes(encodeDataCodewords(bytes, version), version);

	var placed = [];
	for (var r = 0; r < size; r++) placed.push(tpl.modules[r].slice());
	var bitIdx = 0, totalBits = stream.length * 8, up = true;
	for (var right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right--;
		for (var step = 0; step < size; step++) {
			var row = up ? (size - 1 - step) : step;
			for (var dx = 0; dx < 2; dx++) {
				var col = right - dx;
				if (fixed[row][col]) continue;
				var bit = 0;
				if (bitIdx < totalBits) {
					bit = (stream[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
				}
				bitIdx++;
				placed[row][col] = bit;
			}
		}
		up = !up;
	}

	var bestScore = Infinity, bestModules = null;
	for (var mask = 0; mask < 8; mask++) {
		var candidate = [];
		for (var rr = 0; rr < size; rr++) {
			var rowArr = placed[rr].slice();
			for (var cc = 0; cc < size; cc++) {
				if (!fixed[rr][cc] && maskBit(mask, rr, cc)) rowArr[cc] ^= 1;
			}
			candidate.push(rowArr);
		}
		applyFormat(candidate, size, mask);
		var score = penalty(candidate, size);
		if (score < bestScore) {
			bestScore = score;
			bestModules = candidate;
		}
	}
	return { version: version, size: size, modules: bestModules };
}

function pathData(qr, quiet) {
	var parts = [];
	for (var r = 0; r < qr.size; r++) {
		var c = 0;
		while (c < qr.size) {
			if (!qr.modules[r][c]) { c++; continue; }
			var start = c;
			while (c < qr.size && qr.modules[r][c]) c++;
			parts.push('M' + (start + quiet) + ',' + (r + quiet) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z');
		}
	}
	return parts.join('');
}

function svg(text, options) {
	var qr = matrix(text);
	if (!qr) return null;
	options = options || {};
	var quiet = options.quiet != null ? options.quiet : 4;
	var px = options.size || 192;
	var total = qr.size + quiet * 2;
	var ns = 'http://www.w3.org/2000/svg';
	var el = document.createElementNS(ns, 'svg');
	el.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
	el.setAttribute('width', String(px));
	el.setAttribute('height', String(px));
	el.setAttribute('role', 'img');
	el.setAttribute('aria-label', options.label || '节点分享二维码');
	el.setAttribute('shape-rendering', 'crispEdges');
	var bg = document.createElementNS(ns, 'rect');
	bg.setAttribute('width', String(total));
	bg.setAttribute('height', String(total));
	bg.setAttribute('fill', '#ffffff');
	var fg = document.createElementNS(ns, 'path');
	fg.setAttribute('d', pathData(qr, quiet));
	fg.setAttribute('fill', '#111111');
	el.appendChild(bg);
	el.appendChild(fg);
	return el;
}

return baseclass.extend({ matrix: matrix, pathData: pathData, svg: svg });
