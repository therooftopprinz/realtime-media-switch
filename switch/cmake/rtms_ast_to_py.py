#!/usr/bin/env python3
"""Run cum `ast_to_py` on stdin (CUM AST JSON) with RTMS-specific fixes.

Upstream `ast_to_py` skips static array typedef codecs (`session`) and does not
emit field codecs for naked `u8`/`u16`/… sequence members. This wrapper patches
`PyGenerator` in-process so `interface/rtms.cum` yields a complete module.
"""
from __future__ import annotations

import json
import sys

# Caller must set PYTHONPATH to cum's generator/ (same requirement as ast_to_cpp.py).


def _inject_primitives_header():
    import ast_to_py as ap

    emit_header_orig = ap.PyGenerator.emit_header

    def emit_header_patched(self):  # noqa: N802
        emit_header_orig(self)
        print("")
        print("# RTMS: unsigned fixed-width fields (LE, match target_cpp memcpy on LE hosts)")
        print("from cum.cum import read_integral_le, write_integral_le")
        print("# CUM u8/u16/u32/u64 → Python int (TypedDict / list[] annotations only)")
        print("u8 = u16 = u32 = u64 = int")

    ap.PyGenerator.emit_header = emit_header_patched  # type: ignore[method-assign]


def _emit_primitive_helpers():
    print("")
    for n, nbytes in (("u8", 1), ("u16", 2), ("u32", 4), ("u64", 8)):
        print("def encode_using_{0}(v, ctx: PerCodecCtx) -> None:".format(n))
        if nbytes == 1:
            print("    ctx.write_u8(int(v))")
        else:
            mod = 1 << (8 * nbytes)
            print("    if not isinstance(ctx.buf, bytearray):")
            print("        raise CodecError('encode requires a bytearray backing')")
            print(
                "    vv = int(v) % {}\n".format(mod)
                + "    write_integral_le(ctx.buf, ctx.off, vv, {})".format(nbytes)
            )
            print("    ctx.off += {}".format(nbytes))
        print("")
        print("def decode_using_{0}(ctx: PerCodecCtx) -> int:".format(n))
        if nbytes == 1:
            print("    return ctx.read_u8()")
        else:
            print("    if ctx.remaining() < {}:".format(nbytes))
            print("        raise CodecError('decode overrun')")
            print("    v = read_integral_le(ctx.buf, ctx.off, {})".format(nbytes))
            print("    ctx.off += {}".format(nbytes))
            print("    return int(v)")
        print("")

    print("def encode_using_string(v: str, ctx: PerCodecCtx) -> None:")
    print("    ctx.encode_c_string_latin1(v)")
    print("")
    print("def decode_using_string(ctx: PerCodecCtx) -> str:")
    print("    return ctx.decode_c_string_latin1()")
    print("")


def _patch_encode_field():
    import ast_to_py as ap

    _prim = frozenset({"u8", "u16", "u32", "u64"})
    encode_field_orig = ap.PyGenerator._encode_one_field_ordered

    def _encode_one_field_ordered(self, tname, fname):  # noqa: N802
        fa = 'pie["{}"]'.format(fname)
        if tname in _prim:
            print("    encode_using_{}({}, ctx)".format(tname, fa))
            return
        if tname == "string":
            print("    encode_using_string({}, ctx)".format(fa))
            return
        encode_field_orig(self, tname, fname)

    ap.PyGenerator._encode_one_field_ordered = _encode_one_field_ordered  # type: ignore[method-assign]


def _patch_sequence_decode():
    import ast_to_py as ap

    _prim = frozenset({"u8", "u16", "u32", "u64"})

    def emit_sequence_codec(self, name):  # noqa: N802
        flds = self.sequence_[name]
        mask_oct = self._optional_mask_octets_sequence(name)
        sn = ap.cum_name_to_py_snake(name)
        print("# Codec: sequence {}".format(name))
        print("def encode_using_{}(pie, ctx: PerCodecCtx) -> None:".format(sn))
        if not flds:
            print("    pass")
            print("")
            print("def decode_using_{}(ctx: PerCodecCtx):".format(sn))
            print("    return {}")
            print("")
            return
        if mask_oct is not None:
            print("    optional_mask = bytearray({})".format(mask_oct))
            oid = 0
            for tname, fname in flds:
                if tname in self.type_ and self.type_[tname].get("optional"):
                    fa = 'pie["{}"]'.format(fname)
                    print("    if {} is not None:".format(fa))
                    print("        set_optional(optional_mask, {})".format(oid))
                    oid += 1
            print("    ctx.write_bytes(optional_mask, len(optional_mask))")
        for tname, fname in flds:
            self._encode_one_field_ordered(tname, fname)
        print("")
        print("def decode_using_{}(ctx: PerCodecCtx):".format(sn))
        print("    pie = {}".format("{}"))
        if mask_oct is not None:
            print("    optional_mask = ctx.read_bytes({})".format(mask_oct))
        oid = 0
        for tname, fname in flds:
            fa = 'pie["{}"]'.format(fname)
            if tname in self.type_ and self.type_[tname].get("optional"):
                self._decode_optional_field_inline(tname, fa, oid)
                oid += 1
                continue
            snt = ap.cum_name_to_py_snake(tname)
            if tname in _prim:
                print("    {} = decode_using_{}(ctx)".format(fa, tname))
            elif tname == "string":
                print("    {} = decode_using_string(ctx)".format(fa))
            elif tname in self.type_ or tname in self.enum_ or tname in self.sequence_ or tname in self.choice_:
                print("    {} = decode_using_{}(ctx)".format(fa, snt))
            else:
                raise RuntimeError("{} decode {}".format(fname, tname))
        print("    return pie")
        print("")

    ap.PyGenerator.emit_sequence_codec = emit_sequence_codec  # type: ignore[method-assign]


def _patch_using_session():
    import ast_to_py as ap

    using_orig = ap.PyGenerator.emit_using_codec

    def emit_using_codec(self, alias):  # noqa: N802
        td = self.type_[alias]
        if self._pure_optional_td(td):
            return
        if alias == "session" and td.get("array") is not None and td.get("type") == "u8":
            mx = self._cum_int_literal(td["array"])
            sn = ap.cum_name_to_py_snake(alias)
            print("def encode_using_{}(obj, ctx: PerCodecCtx) -> None:".format(sn))
            print("    if len(obj) != {}: raise CodecError('session length')".format(mx))
            print("    ctx.write_count({}, len(obj))".format(mx))
            print("    for it in obj:")
            print("        encode_using_u8(it, ctx)")
            print("")
            print("def decode_using_{}(ctx: PerCodecCtx):".format(sn))
            print("    n = ctx.read_count({})".format(mx))
            print("    arr = []")
            print("    for _ in range(n):")
            print("        arr.append(decode_using_u8(ctx))")
            print("    return arr")
            print("")
            return
        using_orig(self, alias)

    ap.PyGenerator.emit_using_codec = emit_using_codec  # type: ignore[method-assign]


def _patch_emit_enum_codec():
    """Decode PER enums as IntEnum instances (matches TypedDict + .name in clients)."""
    import ast_to_py as ap

    def emit_enum_codec(self, name):  # noqa: N802
        sn = ap.cum_name_to_py_snake(name)
        print(
            "def encode_using_{}(v: int, ctx: PerCodecCtx) -> None:\n".format(sn)
            + "    ctx.write_i32le(int(v))"
        )
        print("")
        print(
            "def decode_using_{}(ctx: PerCodecCtx) -> {}:\n".format(sn, name)
            + "    return {}(int(ctx.read_i32le()))".format(name)
        )
        print("")

    ap.PyGenerator.emit_enum_codec = emit_enum_codec  # type: ignore[method-assign]


def _patch_empty_sequence_typeddict():
    import ast_to_py as ap

    def emit_sequence(self, name):  # noqa: N802
        fields = self.sequence_[name]
        print("class {}(TypedDict):".format(name))
        if not fields:
            print("    pass  # CUM empty sequence")
        else:
            for tname, fname in fields:
                ann = self._field_annotation(tname)
                print("    {}: {}".format(fname, ann))
        print("")

    ap.PyGenerator.emit_sequence = emit_sequence  # type: ignore[method-assign]


def _patch_packed_section_primitives():
    import ast_to_py as ap

    def generate(self):  # noqa: N802
        self.emit_header()
        for kind, nm, _ in self.pass1_expressions_:
            if kind == "constant":
                self.emit_constant(nm)
            elif kind == "enumeration":
                self.emit_enumeration(nm)
            elif kind == "using":
                td = self.type_[nm]
                if td.get("buffer") is not None:
                    self.emit_buffer_td(nm)
                else:
                    self.emit_using_assign(nm)
            elif kind == "sequence":
                self.emit_sequence(nm)
            elif kind == "choice":
                self.emit_choice_wrappers(nm)

        print("# --- Packed encoding (PER-byte aligned, enums as i32 LE) ---\n")
        _emit_primitive_helpers()

        for kind, nm, _ in self.pass1_expressions_:
            if kind == "enumeration":
                self.emit_enum_codec(nm)
            elif kind == "using":
                self.emit_using_codec(nm)

        for kind, nm, _ in self.pass1_expressions_:
            if kind == "sequence":
                self.emit_sequence_codec(nm)
            elif kind == "choice":
                self.emit_choice_codec(nm)

    ap.PyGenerator.generate = generate  # type: ignore[method-assign]


def main() -> None:
    import ast_normalize
    import ast_to_py as ap

    raw = sys.stdin.read()
    doc = json.loads(raw)
    const_, enum_, type_, choice_, seq_, pass1 = ast_normalize.ast_document_to_cpp_state(doc)

    _inject_primitives_header()
    _patch_emit_enum_codec()
    _patch_encode_field()
    _patch_sequence_decode()
    _patch_using_session()
    _patch_empty_sequence_typeddict()
    _patch_packed_section_primitives()

    gen = ap.PyGenerator(const_, enum_, type_, choice_, seq_, pass1)
    gen.generate()


if __name__ == "__main__":
    main()
