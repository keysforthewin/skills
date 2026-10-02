import json, re, html, sys
S = sys.argv[1]
COLS = 100
def xterm(n):
    base = ['#15161e','#f7768e','#9ece6a','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#a9b1d6',
            '#414868','#ff899d','#b9f27c','#ffc777','#8db0ff','#c7a9ff','#a4daff','#c0caf5']
    if n < 16: return base[n]
    if n < 232:
        n -= 16; v = [0,95,135,175,215,255]
        return '#%02x%02x%02x' % (v[n//36], v[(n//6)%6], v[n%6])
    g = 8 + (n-232)*10
    return '#%02x%02x%02x' % (g,g,g)
DEV = re.compile(r'[ऀ-ॿ]+(?:[ ?!,.\-]*[ऀ-ॿ]+)*')
def style_of(st):
    css = []; fg, bg = st.get('fg'), st.get('bg')
    if st.get('inv'): fg, bg = bg or '#11131a', fg or '#d6d3c9'
    if fg: css.append('color:'+fg)
    if bg: css.append('background:'+bg)
    if st.get('bold'): css.append('font-weight:700')
    if st.get('dim'): css.append('opacity:.55')
    if st.get('ital'): css.append('font-style:italic')
    deco = [d for d,k in (('underline','ul'),('line-through','strike')) if st.get(k)]
    if deco: css.append('text-decoration:'+' '.join(deco))
    return ';'.join(css)
def text_html(s, rowlen):
    out = []; pos = 0
    for m in DEV.finditer(s):
        out.append(html.escape(s[pos:m.start()]))
        w = max(1, COLS - (rowlen - len(m.group()))) if rowlen is not None else len(m.group())
        out.append('<span class="dv" style="width:calc(%d * var(--cw))">%s</span>' % (w, html.escape(m.group())))
        pos = m.end()
    out.append(html.escape(s[pos:]))
    return ''.join(out)
def conv(raw):
    rows = []; st = {}
    info = {}
    for ri, line in enumerate(raw.split('\n')):
        plain = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', line)
        if plain.startswith('╭'): info['top'] = ri
        if plain.startswith('╰'): info['bot'] = ri
        if re.match(r'^[^\w\s│╭╰─❯⏵▐▝] \S', plain) and ('…' in plain or 'for ' in plain): info['spin'] = ri
        if 'Play Word Exchange Plaza while' in plain: info['offer'] = ri
        rowlen = len(plain) if plain.rstrip().endswith('│') and DEV.search(plain) else None
        parts = re.split(r'(\x1b\[[0-9;?]*[a-zA-Z])', line); o = []
        for p in parts:
            if p.startswith('\x1b['):
                if not p.endswith('m'): continue
                codes = [int(c) if c else 0 for c in p[2:-1].split(';')]
                i = 0
                while i < len(codes):
                    c = codes[i]
                    if c == 0: st = {}
                    elif c == 1: st['bold'] = 1
                    elif c == 2: st['dim'] = 1
                    elif c == 3: st['ital'] = 1
                    elif c == 4: st['ul'] = 1
                    elif c == 7: st['inv'] = 1
                    elif c == 9: st['strike'] = 1
                    elif c == 22: st.pop('bold',0); st.pop('dim',0)
                    elif c == 23: st.pop('ital',0)
                    elif c == 24: st.pop('ul',0)
                    elif c == 27: st.pop('inv',0)
                    elif c == 29: st.pop('strike',0)
                    elif c in (38,48):
                        k = 'fg' if c == 38 else 'bg'
                        if codes[i+1] == 5: st[k] = xterm(codes[i+2]); i += 2
                        else: st[k] = '#%02x%02x%02x' % tuple(codes[i+2:i+5]); i += 4
                    elif c == 39: st.pop('fg',0)
                    elif c == 49: st.pop('bg',0)
                    elif 30 <= c <= 37: st['fg'] = xterm(c-30)
                    elif 90 <= c <= 97: st['fg'] = xterm(c-82)
                    elif 40 <= c <= 47: st['bg'] = xterm(c-40)
                    i += 1
            elif p:
                t = text_html(p, rowlen); s = style_of(st)
                t = t.replace('│', '<span class="vb">│</span>')
                o.append('<span style="%s">%s</span>' % (s, t) if s else t)
        rows.append('<div class="r">%s</div>' % ''.join(o))
    return ''.join(rows[:30]), info
idx = json.load(open(S + '/frames/index.json')); out = []
for f in idx:
    raw = open(S + '/frames/%05d.ans' % f['n'], encoding='utf8').read()
    raw = re.sub(r'/…/[0-9a-f\-]{36}/scratchpad/todo-cli', '~/code/todo-cli', raw)
    raw = re.sub(r'/tmp/claude-1000/-home-mulligan-code-skills/[0-9a-f\-]{36}/scratchpad/', '~/code/', raw)
    h, info = conv(raw)
    out.append({'t': f['t'], 'h': h, **info})
open(S + '/frames.js', 'w').write('window.FRAMES=' + json.dumps(out, ensure_ascii=False) + ';')
print(len(out), sum(len(o['h']) for o in out)//1024, 'KB')
for n in (16, 77, 130, 160, 225, 232): print(n, {k:v for k,v in out[n].items() if k not in 'h'})
