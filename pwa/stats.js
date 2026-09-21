/**
 * 健康指標の判定ロジック（DOM非依存の純関数）
 *
 * ブラウザと Node の両方から使う。判定の誤りは「気づけるはずの不調を見逃す」か
 * 「問題ないのに不安にさせる」のどちらかに直結するため、境界条件を明示的に扱う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // 0 が測定値としてありえない指標。時計を着けていない日の 0 を平均に含めると
  // 平均が下振れするため、欠損として扱う。
  // （active_minutes や workout_count の 0 は「休んだ日」として妥当なので含めない）
  const ZERO_IS_MISSING = new Set([
    'steps', 'hr_avg', 'hr_min', 'hr_max', 'resting_hr',
    'spo2_avg', 'spo2_min', 'spo2_max', 'resp_rate',
    'hrv_ms', 'hrv_deep_rmssd', 'nonrem_hr',
    'sleep_total_min', 'total_kcal', 'weight_kg', 'body_fat_pct', 'skin_temp_c',
  ]);

  // 時計から得られる指標。未装着の日はこれらをまとめて信用しない。
  // 体重・体組成・栄養は別経路なので対象外。
  const WATCH_DERIVED = new Set([
    'steps', 'distance_km', 'floors', 'active_kcal', 'total_kcal',
    'active_minutes', 'active_min_light', 'active_min_moderate', 'active_min_vigorous',
    'active_zone_minutes', 'sedentary_min',
    'hr_avg', 'hr_min', 'hr_max', 'resting_hr',
    'hrv_ms', 'hrv_deep_rmssd', 'hrv_entropy', 'nonrem_hr',
    'sleep_total_min', 'sleep_deep_min', 'sleep_light_min', 'sleep_rem_min', 'sleep_awake_min',
    'spo2_avg', 'spo2_min', 'spo2_max', 'resp_rate',
    'skin_temp_c', 'skin_temp_delta',
  ]);

  const MIN_SAMPLES   = 7;    // これ未満なら判定しない
  const DEFAULT_DAYS  = 30;   // ベースラインの窓

  // ── データアクセス ──────────────────────────────────────────
  function index(payload) {
    const m = {};
    payload.columns.forEach((c, i) => { m[c] = i; });
    return m;
  }

  /** その日の時計データが信用できるか（hr_avg があれば着けていたとみなす） */
  function isWornDay(payload, row) {
    const i = index(payload)['hr_avg'];
    return i !== undefined && row[i] !== null && row[i] !== 0;
  }

  /** 列の値を取り出す。欠損・無効値は null にそろえる */
  function valueOf(payload, row, col) {
    const i = index(payload)[col];
    if (i === undefined) return null;

    const v = row[i];
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'number') return v;
    if (!isFinite(v)) return null;
    if (v === 0 && ZERO_IS_MISSING.has(col)) return null;
    if (WATCH_DERIVED.has(col) && !isWornDay(payload, row)) return null;
    return v;
  }

  /** 日付 → 行 の対応 */
  function rowOf(payload, date) {
    const i = index(payload)['date'];
    return payload.rows.find(r => r[i] === date) || null;
  }

  /** [{date, value}] を古い順で返す（欠損は除外） */
  function series(payload, col) {
    const di = index(payload)['date'];
    return payload.rows
      .map(r => ({ date: r[di], value: valueOf(payload, r, col) }))
      .filter(p => typeof p.value === 'number')
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ── ベースライン ────────────────────────────────────────────
  /**
   * endDate より前の days 日間から平均と標準偏差を出す。
   * endDate 当日は含めない（自分自身と比較しても意味がないため）。
   */
  function baseline(payload, col, endDate, days) {
    days = days || DEFAULT_DAYS;
    const start = shiftDate(endDate, -days);

    const vals = series(payload, col)
      .filter(p => p.date >= start && p.date < endDate)
      .map(p => p.value);

    if (vals.length < MIN_SAMPLES) return { mean: null, sd: null, n: vals.length };

    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varc = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
    return { mean: mean, sd: Math.sqrt(varc), n: vals.length };
  }

  /** z スコア。判定できない場合は null */
  function zscore(value, base) {
    if (typeof value !== 'number') return null;
    if (!base || base.mean === null) return null;
    if (!base.sd) return null;                 // 標準偏差0（全日同値）は判定不能
    return (value - base.mean) / base.sd;
  }

  /** z を日本語のラベルにする */
  function judge(z) {
    if (z === null) return { level: 'unknown', label: '判定できません' };
    const a = Math.abs(z);
    if (a < 1) return { level: 'usual', label: 'いつもどおり' };
    const dir = z > 0 ? '高い' : '低い';
    if (a < 2) return { level: 'slight', label: 'やや' + dir };
    return { level: 'strong', label: 'かなり' + dir };
  }

  // ── 基準範囲 ────────────────────────────────────────────────
  /**
   * 一般的な基準範囲との比較。
   * baselineOnly の指標や範囲未定義の指標では null を返す（絶対評価を出さない）。
   */
  function inRange(col, value, ranges) {
    const r = (ranges || {})[col];
    if (!r || r.baselineOnly || typeof value !== 'number') return null;

    if (r.goal !== undefined) {
      return value >= r.goal
        ? { status: 'ok',    label: '目安を達成' }
        : { status: 'below', label: '目安に届かず' };
    }
    if (r.min !== undefined && value < r.min) return { status: 'low',  label: '目安より低い' };
    if (r.max !== undefined && value > r.max) return { status: 'high', label: '目安より高い' };
    return { status: 'ok', label: '目安の範囲内' };
  }

  // ── 体調の前触れ ────────────────────────────────────────────
  /**
   * 安静時心拍・呼吸数・皮膚温がそろって平常より高い日を拾う。
   * 単独では日々の揺らぎと区別できないが、3つ同時なら意味を持つ。
   */
  function illnessSignal(payload, date, days) {
    const cols = ['resting_hr', 'resp_rate', 'skin_temp_delta'];
    const row  = rowOf(payload, date);
    if (!row) return { triggered: false, reason: 'no-data', details: [] };

    const details = cols.map(col => {
      const v = valueOf(payload, row, col);
      const z = zscore(v, baseline(payload, col, date, days));
      return { col: col, value: v, z: z };
    });

    if (details.some(d => d.z === null)) {
      return { triggered: false, reason: 'insufficient', details: details };
    }
    return {
      triggered: details.every(d => d.z >= 1),
      reason: 'ok',
      details: details,
    };
  }

  // ── 長期傾向 ────────────────────────────────────────────────
  /** 直近30日平均と直近90日平均を比べ、上昇/下降傾向を返す */
  function trend(payload, col, date) {
    const short = baseline(payload, col, date, 30);
    const long  = baseline(payload, col, date, 90);
    if (short.mean === null || long.mean === null || !long.sd) {
      return { direction: 'unknown', short: short, long: long };
    }
    const diff = (short.mean - long.mean) / long.sd;
    return {
      direction: diff > 0.3 ? 'up' : diff < -0.3 ? 'down' : 'flat',
      short: short, long: long, diff: diff,
    };
  }

  // ── 列構成の変化への追従 ────────────────────────────────────
  /**
   * 古い行を新しい列構成に並べ替える。対応付けは列名で行う。
   *
   * 列が増減したときに手元のデータを捨てると、端末に溜めた履歴が消えてしまう。
   * 欠けている列は null（0ではない）で埋め、欠損として扱わせる。
   */
  function remapRows(oldCols, newCols, rows) {
    const idx = {};
    oldCols.forEach((c, i) => { idx[c] = i; });
    return rows.map(r => newCols.map(c => (idx[c] === undefined ? null : r[idx[c]])));
  }

  // ── 表示対象日 ──────────────────────────────────────────────
  /**
   * 表示する日付を決める。
   *
   * 同期は毎朝5時に走るため、当日の行は数時間分しか埋まっていない。
   * そのまま出すと歩数などが極端に低く見えるので、既定では「昨日」を見る。
   * 昨日の行が無い（同期前・欠測）場合は、それ以前で最も新しい装着日まで遡る。
   */
  function targetDate(payload, today) {
    const di = index(payload)['date'];
    if (!payload.rows.length) return null;

    const limit = shiftDate(today, -1);   // 昨日まで

    for (let i = payload.rows.length - 1; i >= 0; i--) {
      const r = payload.rows[i];
      if (r[di] <= limit && isWornDay(payload, r)) return r[di];
    }
    // 装着日が見つからなければ、昨日以前で最も新しい行
    for (let i = payload.rows.length - 1; i >= 0; i--) {
      if (payload.rows[i][di] <= limit) return payload.rows[i][di];
    }
    return payload.rows[payload.rows.length - 1][di];
  }

  /** 端末のタイムゾーンによらず JST の今日を返す */
  function todayJST() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ── 日付ユーティリティ ──────────────────────────────────────
  /** 'yyyy-MM-dd' を n 日ずらす（UTC正午起点で丸め誤差を避ける） */
  function shiftDate(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  return {
    MIN_SAMPLES: MIN_SAMPLES,
    ZERO_IS_MISSING: ZERO_IS_MISSING,
    index: index, isWornDay: isWornDay, valueOf: valueOf, rowOf: rowOf, series: series,
    baseline: baseline, zscore: zscore, judge: judge, inRange: inRange,
    illnessSignal: illnessSignal, trend: trend, shiftDate: shiftDate,
    targetDate: targetDate, todayJST: todayJST, remapRows: remapRows,
  };
});
