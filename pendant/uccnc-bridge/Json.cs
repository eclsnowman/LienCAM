// Minimal JSON reader/writer for the bridge protocol.
//
// The bridge builds with the in-box csc.exe and nothing else - no NuGet, no
// Visual Studio, no System.Web.Extensions reference. The protocol's messages
// are small and their shapes are fixed (docs/machine/BRIDGE-PROTOCOL.md), so a
// hand-rolled codec is cheaper than a build dependency and easier to audit.
//
// Object model:
//   null            -> null
//   true/false      -> bool
//   number          -> double
//   string          -> string
//   array           -> List<object>
//   object          -> Dictionary<string, object>   (ordinal keys)

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace LienCAM
{
    static class Json
    {
        // ---- write --------------------------------------------------------
        public static string Write(object v)
        {
            var sb = new StringBuilder();
            WriteTo(sb, v);
            return sb.ToString();
        }

        static void WriteTo(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }

            if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
            if (v is string) { WriteString(sb, (string)v); return; }

            if (v is int || v is long || v is short)
            {
                sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (v is double || v is float || v is decimal)
            {
                double d = Convert.ToDouble(v);
                // JSON has no NaN or Infinity. Absent data is null - never a
                // substituted number (BRIDGE-PROTOCOL.md).
                if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            var obj = v as Obj;
            if (obj != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (var kv in obj.Pairs)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    WriteTo(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }

            var dict = v as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    WriteTo(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }

            var list = v as System.Collections.IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteTo(sb, item);
                }
                sb.Append(']');
                return;
            }

            WriteString(sb, v.ToString());
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < ' ' || ch > '~') sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }

        /** Ordered map, so written messages keep a stable, readable field order
         *  and two identical snapshots serialise to identical text (the status
         *  push loop compares text to decide whether anything changed). */
        public class Obj
        {
            readonly List<KeyValuePair<string, object>> pairs = new List<KeyValuePair<string, object>>();

            public IEnumerable<KeyValuePair<string, object>> Pairs { get { return pairs; } }

            public Obj Set(string k, object v)
            {
                for (int i = 0; i < pairs.Count; i++)
                    if (pairs[i].Key == k) { pairs[i] = new KeyValuePair<string, object>(k, v); return this; }
                pairs.Add(new KeyValuePair<string, object>(k, v));
                return this;
            }

            public object this[string k]
            {
                get { foreach (var kv in pairs) if (kv.Key == k) return kv.Value; return null; }
                set { Set(k, value); }
            }
        }

        // ---- read ---------------------------------------------------------
        /** Returns false rather than throwing: a malformed frame is an operator
         *  problem, not a crash. */
        public static bool TryParse(string text, out object value)
        {
            value = null;
            try
            {
                int i = 0;
                object v = ParseValue(text, ref i);
                SkipWs(text, ref i);
                if (i != text.Length) return false;
                value = v;
                return true;
            }
            catch { return false; }
        }

        static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i);
            if (c == '[') return ParseArray(s, ref i);
            if (c == '"') return ParseString(s, ref i);
            if (Match(s, ref i, "true")) return true;
            if (Match(s, ref i, "false")) return false;
            if (Match(s, ref i, "null")) return null;
            return ParseNumber(s, ref i);
        }

        static bool Match(string s, ref int i, string lit)
        {
            if (i + lit.Length > s.Length) return false;
            if (string.CompareOrdinal(s, i, lit, 0, lit.Length) != 0) return false;
            i += lit.Length;
            return true;
        }

        static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var d = new Dictionary<string, object>(StringComparer.Ordinal);
            i++;                                             // '{'
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (true)
            {
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("key expected");
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("':' expected");
                i++;
                d[key] = ParseValue(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return d; }
                throw new FormatException("',' or '}' expected");
            }
        }

        static List<object> ParseArray(string s, ref int i)
        {
            var a = new List<object>();
            i++;                                             // '['
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return a; }
            while (true)
            {
                a.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return a; }
                throw new FormatException("',' or ']' expected");
            }
        }

        static string ParseString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++;                                             // '"'
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad \\u");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber,
                                                  CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
            throw new FormatException("unterminated string");
        }

        static double ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (i == start) throw new FormatException("number expected");
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float,
                                CultureInfo.InvariantCulture);
        }

        // ---- typed accessors ----------------------------------------------
        public static Dictionary<string, object> AsObj(object v)
        {
            return v as Dictionary<string, object>;
        }

        public static object Get(object obj, string key)
        {
            var d = obj as Dictionary<string, object>;
            object v;
            if (d != null && d.TryGetValue(key, out v)) return v;
            return null;
        }

        public static bool TryNum(object v, out double d)
        {
            d = 0;
            if (v is double) { d = (double)v; return true; }
            if (v is int) { d = (int)v; return true; }
            return false;
        }

        public static double Num(object obj, string key, double dflt)
        {
            double d;
            return TryNum(Get(obj, key), out d) ? d : dflt;
        }

        public static string Str(object obj, string key)
        {
            return Get(obj, key) as string;
        }

        public static bool Bool(object obj, string key, bool dflt)
        {
            object v = Get(obj, key);
            return v is bool ? (bool)v : dflt;
        }

        public static List<object> Arr(object obj, string key)
        {
            return Get(obj, key) as List<object>;
        }
    }
}
