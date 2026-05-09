import test from "node:test";
import assert from "node:assert/strict";

function makeSdu(t, body) {
  const out = new Uint8Array(1 + body.length);
  out[0] = t & 0xff;
  out.set(body, 1);
  return out;
}

test("SDU length and type byte", () => {
  const sdu = makeSdu(0, new TextEncoder().encode("hi"));
  assert.equal(sdu[0], 0);
  assert.equal(sdu.length, 3);
  assert.equal(new TextDecoder().decode(sdu.subarray(1)), "hi");
});
