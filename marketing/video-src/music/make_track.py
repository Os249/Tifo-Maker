"""
The teaser's music: an original 30 s track, 120 BPM, A minor (Am F C G),
synthesised here so there is no licence to clear. The video's cuts sit on its
beats (one beat = 0.5 s; the drop is at 2.0 s, where the film's reveal starts;
the last hit is at 26.0 s, the end card).

    python3 make_track.py ../public/track.wav
"""
import sys, wave
import numpy as np

SR = 44100
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 15
N = int(SR * BARS * BAR)
rng = np.random.default_rng(7)
t_all = np.arange(N) / SR

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def add(buf, sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N: return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[0, i:i + len(sig)] += sig * gain * l
    buf[1, i:i + len(sig)] += sig * gain * r

def env(n, a, d, curve=4.0):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-curve * t / d)

def saw(f, n, harmonics=12, bright=1.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if f * k > SR / 2.2: break
        out += np.sin(2 * np.pi * f * k * t) / k ** bright
    return out

def kick():
    n = int(0.42 * SR); t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    click = rng.standard_normal(n) * np.exp(-t * 400) * 0.25
    return np.tanh((body + click) * 1.6)

def hp(x, times=1):
    for _ in range(times): x = np.diff(x, prepend=0)
    return x

def clap():
    n = int(0.28 * SR); t = np.arange(n) / SR
    noise = hp(rng.standard_normal(n))
    e = np.zeros(n)
    for off in (0.0, 0.011, 0.023):
        k = int(off * SR)
        e[k:] += np.exp(-(t[: n - k]) * 60)
    e += np.exp(-t * 16) * 0.5
    return noise * e * 0.5

def hat(open_=False):
    n = int((0.16 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 2) * np.exp(-t * (22 if open_ else 90)) * 0.22

def tom(m):
    n = int(0.3 * SR); t = np.arange(n) / SR
    f = hz(m) * (1 + 0.5 * np.exp(-t * 30))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)

def pluck(m, dur=0.22, bright=1.15):
    n = int(dur * SR)
    return (saw(hz(m), n, 14, bright) + 0.5 * saw(hz(m) * 1.004, n, 10, bright)) * env(n, 0.002, dur, 5)

def lead(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    f = hz(m) * (1 + 0.004 * np.sin(2 * np.pi * 5.5 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    sig = np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.3 * np.sin(3 * ph) + 0.12 * np.sin(5 * ph)
    e = np.minimum(1, t / 0.01) * np.minimum(1, (dur - t) / 0.04).clip(0, 1)
    return sig * e

def bass(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    f = hz(m)
    sig = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(4 * np.pi * f * t) + 0.22 * np.sin(6 * np.pi * f * t)
    return np.tanh(sig * 1.4) * np.minimum(1, t / 0.006) * np.exp(-t * 3.5)

def pad(notes, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    out = np.zeros(n)
    for m in notes:
        for det in (0.997, 1.003):
            out += saw(hz(m) * det, n, 6, 1.6)
    e = np.minimum(1, t / 0.25) * np.minimum(1, (dur - t) / 0.3).clip(0, 1)
    return out * e / len(notes)

# Am F C G: root (bass), triad (pad), arp tones.
CH = [
    dict(root=45, pad=[57, 60, 64], arp=[69, 72, 76, 81]),
    dict(root=41, pad=[57, 60, 65], arp=[69, 72, 77, 81]),
    dict(root=48, pad=[55, 60, 64], arp=[67, 72, 76, 79]),
    dict(root=43, pad=[55, 59, 62], arp=[67, 71, 74, 79]),
]
ARP = [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 3, 2, 1, 3, 2]
# The hook, in eighths (None = rest); one bar per chord.
HOOK = [
    [76, None, 81, None, 79, 76, None, 72],
    [77, None, 81, None, 79, 77, None, 72],
    [76, None, 79, None, 84, 79, None, 76],
    [74, None, 79, None, 83, None, 81, 79],
]

drums = np.zeros((2, N)); music = np.zeros((2, N)); duck = np.ones(N)
K, C, H_, HO = kick(), clap(), hat(), hat(True)
DROP, END = 1, 13  # bars: the beat comes in; the end card

for bar in range(BARS):
    t0 = bar * BAR
    ch = CH[bar % 4]
    full = DROP <= bar < END
    # Drums
    for b in range(4):
        if full:
            add(drums, K, t0 + b * BEAT, 0.95)
            i = int((t0 + b * BEAT) * SR); n = int(0.24 * SR)
            duck[i:i + n] = np.minimum(duck[i:i + n], 0.35 + 0.65 * (np.arange(n) / n) ** 1.5)
            add(drums, H_ if b != 3 else HO, t0 + (b + 0.5) * BEAT, 0.9, 0.25)
            if bar >= 5:
                add(drums, H_, t0 + (b + 0.25) * BEAT, 0.45, -0.3); add(drums, H_, t0 + (b + 0.75) * BEAT, 0.45, 0.35)
        if b in (1, 3) and bar < END:
            add(drums, C, t0 + b * BEAT, 0.8 if full else 0.55)
    if bar in (0, 4, 8, 12):  # a tabl-style fill into the next bar
        for k, m in enumerate([57, 57, 52, 52, 48, 48, 45, 43]):
            add(drums, tom(m), t0 + 2 * BEAT + k * BEAT / 4, 0.55, (k - 3.5) / 5)
    # Bass: offbeat eighths under the beat, a held root before it
    if full:
        for e8 in range(8):
            m = ch['root'] - 12 if e8 % 2 else ch['root'] - 12
            if e8 % 2 == 1 or bar >= 5:
                add(music, bass(m, BEAT * 0.48), t0 + e8 * BEAT / 2, 0.55)
    # Pad
    if bar < END:
        add(music, pad(ch['pad'], BAR), t0, 0.16 if full else 0.22)
    # Arp: sixteenths, quieter and darker in the intro
    if bar < END:
        for s16 in range(16):
            m = ch['arp'][ARP[s16]]
            g = 0.15 if full else 0.11
            sig = pluck(m, 0.2, 1.1 if full else 1.7)
            add(music, sig, t0 + s16 * BEAT / 4, g, -0.35 if s16 % 2 else 0.35)
            add(music, sig, t0 + s16 * BEAT / 4 + 0.375, g * 0.35, 0.5 if s16 % 2 else -0.5)  # dotted-eighth echo
    # The hook, from bar 3, an octave doubled from bar 7
    if 3 <= bar < END:
        for e8, m in enumerate(HOOK[bar % 4]):
            if m is None: continue
            add(music, lead(m, BEAT * 0.46), t0 + e8 * BEAT / 2, 0.2)
            add(music, lead(m, BEAT * 0.46), t0 + e8 * BEAT / 2 + 0.25, 0.06, 0.4)
            if bar >= 7: add(music, lead(m + 12, BEAT * 0.46), t0 + e8 * BEAT / 2, 0.07, -0.2)

# The riser into the drop, and the last hit with a held chord.
n = int(1.0 * SR); tt = np.arange(n) / SR
riser = hp(rng.standard_normal(n)) * (tt / 1.0) ** 2 * 0.25
add(music, riser, DROP * BAR - 1.0, 1.0)
for at in (DROP * BAR, END * BAR):
    n = int(1.6 * SR); tt = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(38 + 70 * np.exp(-tt * 10)) / SR) * np.exp(-tt * 2.5)
    crash = hp(rng.standard_normal(n), 2) * np.exp(-tt * 3.5) * 0.2
    add(drums, boom * 0.9 + crash, at, 0.9)
add(music, pad([57, 60, 64, 69], 2 * BAR) + 0.6 * pad([45, 52], 2 * BAR), END * BAR, 0.3)
for k, m in enumerate([69, 72, 76, 81, 84]):
    add(music, pluck(m, 0.9, 1.2), END * BAR + k * BEAT / 2, 0.22, (k - 2) / 3)

mix = drums + music * duck
mix[:, -int(1.2 * SR):] *= np.linspace(1, 0, int(1.2 * SR)) ** 1.5
mix = np.tanh(mix * 1.5)
mix *= 0.89 / np.abs(mix).max()
out = sys.argv[1] if len(sys.argv) > 1 else 'track.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(out, round(N / SR, 2), 's')
