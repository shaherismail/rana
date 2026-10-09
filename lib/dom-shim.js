/**
 * Minimal DOM globals shim for pdf.js / pdf-parse on non-browser runtimes.
 *
 * pdf-parse's worker calls `new DOMMatrix(...)` unconditionally. On a browser
 * that is native; on Vercel's Node runtime (and Node 22 without a DOM) it is
 * undefined, which kills the whole serverless function with
 * "DOMMatrix is not defined".
 *
 * Only the pieces pdf.js actually touches are implemented.
 */

class DOMPoint {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
}

class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  get top() {
    return this.y;
  }
  get left() {
    return this.x;
  }
  get right() {
    return this.x + this.width;
  }
  get bottom() {
    return this.y + this.height;
  }
}

/** 2D/3D matrix using the column-major [m11..m44] layout the DOM spec uses. */
class DOMMatrix {
  constructor(transform) {
    this.is2D = true;
    this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
    this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
    this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
    this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;

    if (typeof transform === 'string') {
      // Only the identity + translate/scale shortcuts pdf.js needs are parsed.
      const s = transform.trim();
      if (s === 'none' || s === '') return;
      const nums = (s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
      if (/^matrix3d/i.test(s) && nums.length === 16) this._set16(nums);
      else if (/^matrix/i.test(s) && nums.length === 6) this._set6(nums);
      else if (/^translate/i.test(s)) { this.m41 = nums[0] || 0; this.m42 = nums[1] || 0; }
      else if (/^scale/i.test(s)) {
        const sx = nums[0] !== undefined ? nums[0] : 1;
        const sy = nums.length > 1 ? nums[1] : sx;
        this.m11 = sx; this.m22 = sy;
      }
      return;
    }
    if (Array.isArray(transform)) {
      if (transform.length === 16) this._set16(transform);
      else if (transform.length === 6) this._set6(transform);
    }
  }

  _set6(a) {
    [this.m11, this.m12, this.m21, this.m22, this.m41, this.m42] = a;
  }

  _set16(a) {
    this.is2D = false;
    [
      this.m11, this.m12, this.m13, this.m14,
      this.m21, this.m22, this.m23, this.m24,
      this.m31, this.m32, this.m33, this.m34,
      this.m41, this.m42, this.m43, this.m44,
    ] = a;
  }

  translateSelf(x = 0, y = 0, z = 0) {
    this.m41 += this.m11 * x + this.m21 * y + this.m31 * z;
    this.m42 += this.m12 * x + this.m22 * y + this.m32 * z;
    this.m43 += this.m13 * x + this.m23 * y + this.m33 * z;
    this.m44 += this.m14 * x + this.m24 * y + this.m34 * z;
    return this;
  }

  scaleSelf(sx = 1, sy = sx, sz = 1, ox = 0, oy = 0, oz = 0) {
    this.translateSelf(ox, oy, oz);
    this.m11 *= sx; this.m12 *= sx; this.m13 *= sx; this.m14 *= sx;
    this.m21 *= sy; this.m22 *= sy; this.m23 *= sy; this.m24 *= sy;
    this.m31 *= sz; this.m32 *= sz; this.m33 *= sz; this.m34 *= sz;
    this.translateSelf(-ox, -oy, -oz);
    return this;
  }

  multiplySelf(other) {
    this.m11 = other.m11 * this.m11 + other.m21 * this.m12;
    this.m12 = other.m11 * this.m12 + other.m21 * this.m22;
    this.m21 = other.m12 * this.m11 + other.m22 * this.m12;
    this.m22 = other.m12 * this.m12 + other.m22 * this.m22;
    return this;
  }

  inverse() {
    return new DOMMatrix();
  }

  transformPoint(p) {
    return new DOMPoint(
      this.m11 * p.x + this.m21 * p.y + this.m31 * p.z + this.m41 * p.w,
      this.m12 * p.x + this.m22 * p.y + this.m32 * p.z + this.m42 * p.w,
      this.m13 * p.x + this.m23 * p.y + this.m33 * p.z + this.m43 * p.w,
      this.m14 * p.x + this.m24 * p.y + this.m34 * p.z + this.m44 * p.w,
    );
  }
}

/** Install the shims only where the runtime does not already provide them. */
export function installDomShims() {
  if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = DOMMatrix;
  if (typeof globalThis.DOMPoint === 'undefined') globalThis.DOMPoint = DOMPoint;
  if (typeof globalThis.DOMRect === 'undefined') globalThis.DOMRect = DOMRect;
}
