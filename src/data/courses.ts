import { CourseCharacteristics } from '../types/keiba';

export const JRA_COURSES: Record<string, CourseCharacteristics> = {
  'nakayama_turf_1200': {
    trackId: 'nakayama_turf_1200',
    trackName: '中山',
    surface: '芝',
    distance: 1200,
    courseType: '外',
    turnType: '右回り',
    straightLength: 310,
    slopeHeight: 5.3,
    slopeDetail: 'スタート直後から4.5mの下り坂が続き超ハイペース必至。ゴール前100mに高低差2.2mの急坂。',
    description: 'スタートはおむすび型の第2コーナー奥。初角まで約500m下り坂を疾走するため激しい先行争いが起きる。直線は310mと短く、急坂で失速しない先行力とパワーが不可欠。開幕週〜中盤は内ラチ沿いの経済コースを通った馬が圧倒的。',
    frameBias: {
      inside: 1.15, // 内枠有利 (ロスなく回れる)
      middle: 1.02,
      outside: 0.88, // 外枠は外を回されるロスが大きい
    },
    styleBias: {
      nige: 1.25, // 逃げ超有利
      senko: 1.18, // 先行有利
      sashi: 0.88,
      oikomi: 0.65, // 追込は絶望的（4角で外を回すと届かない）
    },
    heavyTrackStyleShift: {
      frontBonus: 0.15, // 重馬場になるとさらに前が止まらない
    },
    historicalPaceData: {
      frontRunnerWinRate: 15.2,
      frontRunnerPlaceRate: 40.0,
      frontRunner3rdCount: 4, // 過去10年のスプリンターズSでハナを切った馬が4回3着以内に好走
      frontRunnerTotal: 10,
      bestPassingRankTrend: '1〜4番手（4角5番手以内が連対の80%）',
      keyInsight: 'スプリンターズSでは、スタート直後にハナを切った逃げ馬がハイペースで玉砕すると思われがちだが、過去10年で3着以内が4回（複勝率40%）。中山の短い直線と急坂、そして最短内ラチを通るアドバンテージにより、ハナ切り馬の3着粘り込みは中穴・大穴の典型パターン。',
    },
  },

  'tokyo_turf_2000': {
    trackId: 'tokyo_turf_2000',
    trackName: '東京',
    surface: '芝',
    distance: 2000,
    courseType: '内',
    turnType: '左回り',
    straightLength: 525.9,
    slopeHeight: 2.7,
    slopeDetail: '向正面からスタート、2コーナー手前までの距離がわずか130m。直線に高低差2mの上り坂。',
    description: '「魔の2コーナー」と呼ばれる独特のコース。スタート直後にすぐ左コーナーがあるため大外枠（8枠）は外に振られて極端に不利。直線は525.9mと日本屈指の長さで、上がり3F33秒台の強烈な瞬発力（切れ味）が要求される。',
    frameBias: {
      inside: 1.22, // 1〜3枠が断然有利
      middle: 1.00,
      outside: 0.80, // 8枠は大きな割引材料
    },
    styleBias: {
      nige: 0.90, // 直線が長いため逃げ切りは至難
      senko: 1.10,
      sashi: 1.22, // 差し馬の好走率が極めて高い
      oikomi: 1.05,
    },
    heavyTrackStyleShift: {
      frontBonus: 0.08,
    },
    historicalPaceData: {
      frontRunnerWinRate: 9.1,
      frontRunnerPlaceRate: 22.5,
      frontRunner3rdCount: 2,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '4〜7番手（中団で脚を溜めた差し馬）',
      keyInsight: '天皇賞(秋)では、逃げ馬がよほど超スローで単騎逃げを打たない限り、長い直線で強烈な上がりを使える好位〜中団差し馬が台頭。ただしパンサラッサのような大逃げ馬が稍重等でセーフティリードを作ると波乱を演出する。',
    },
  },

  'tokyo_turf_2400': {
    trackId: 'tokyo_turf_2400',
    trackName: '東京',
    surface: '芝',
    distance: 2400,
    courseType: '内',
    turnType: '左回り',
    straightLength: 525.9,
    slopeHeight: 2.7,
    slopeDetail: 'スタンド前直線の急坂下からスタート。コーナーを4つ回る。直線に2mの坂。',
    description: '日本ダービー・ジャパンカップが行われる日本最高峰のチャンピオンコース。正面スタンド前からスタートし、最初のコーナーまで約350mあるため枠順の有利不利が比較的少ない。直線の長さと坂を克服する底力、スタミナ、瞬発力すべてのバランスが求められる。',
    frameBias: {
      inside: 1.08, // 1枠（白帽）の好走が有名（ダービー1枠神話）
      middle: 1.02,
      outside: 0.94,
    },
    styleBias: {
      nige: 0.85,
      senko: 1.12,
      sashi: 1.20,
      oikomi: 1.02,
    },
    heavyTrackStyleShift: {
      frontBonus: 0.10,
    },
    historicalPaceData: {
      frontRunnerWinRate: 7.8,
      frontRunnerPlaceRate: 20.0,
      frontRunner3rdCount: 2,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '3〜6番手（直線で外から一気に伸びる王道の差し）',
      keyInsight: '日本ダービーやJCでは「上がり3F最速馬」の複勝率が70%を超える。ハナを切った逃げ馬は厳しいが、スローペースで道中息を入れた場合の逃げ残り（キタサンブラック型）や2番手追走馬の押し切りに注意。',
    },
  },

  'nakayama_turf_2500': {
    trackId: 'nakayama_turf_2500',
    trackName: '中山',
    surface: '芝',
    distance: 2500,
    courseType: '内',
    turnType: '右回り',
    straightLength: 310,
    slopeHeight: 5.3,
    slopeDetail: '外回り3コーナー手前からスタート。急坂を2度上り、コーナーを6つ回る。',
    description: '有馬記念の舞台。スタートから最初のコーナーまでわずか192mしかなく、外枠（特に7・8枠）は外を回らされるロスが致命的。コーナーを6回回る器用さと、3コーナー手前からのロングスパートに耐えるタフなスタミナ、中山の急坂を2度登るパワーが不可欠。',
    frameBias: {
      inside: 1.25, // 1〜3枠絶好
      middle: 1.00,
      outside: 0.78, // 8枠は過去10年連対ゼロ等、大減点
    },
    styleBias: {
      nige: 1.05,
      senko: 1.22, // 先行抜け出しがベスト
      sashi: 1.15, // まくり差し
      oikomi: 0.75, // 直線一気は届かない
    },
    heavyTrackStyleShift: {
      frontBonus: 0.12,
    },
    historicalPaceData: {
      frontRunnerWinRate: 12.0,
      frontRunnerPlaceRate: 31.0,
      frontRunner3rdCount: 3,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '2〜5番手（内ラチ沿い好位キープ）',
      keyInsight: '有馬記念では8枠が極めて不振。また、逃げ馬が単騎でマイペースに持ち込んだ場合、3コーナーからの仕掛け遅れを誘って2〜3着に粘り込むケース（キタサンブラック、タイトルホルダー等）が頻発する。',
    },
  },

  'kyoto_turf_1600_outer': {
    trackId: 'kyoto_turf_1600_outer',
    trackName: '京都',
    surface: '芝',
    distance: 1600,
    courseType: '外',
    turnType: '右回り',
    straightLength: 398.7,
    slopeHeight: 4.3,
    slopeDetail: '向正面の「淀の坂」を上り、3コーナーから一気に下る。直線は平坦。',
    description: 'マイルチャンピオンシップの舞台。向正面中ほどからスタートし、名物の丘（高低差4.3m）を上り、下り坂の勢いを使って4コーナーへ侵入する。下り坂で急加速するためコーナリングの上手さと、直線平坦でのトップスピード維持が鍵。',
    frameBias: {
      inside: 1.05,
      middle: 1.02,
      outside: 0.98,
    },
    styleBias: {
      nige: 0.95,
      senko: 1.12,
      sashi: 1.18,
      oikomi: 1.00,
    },
    heavyTrackStyleShift: {
      frontBonus: 0.10,
    },
    historicalPaceData: {
      frontRunnerWinRate: 8.5,
      frontRunnerPlaceRate: 24.0,
      frontRunner3rdCount: 2,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '4〜8番手',
      keyInsight: '3コーナー下り坂でスピードに乗るため、前が速くなり差し馬の台頭が多い。ただし直線が平坦なため、道悪でインコースが生きていれば先行勢の前残りが急浮上する。',
    },
  },

  'hanshin_turf_2200_inner': {
    trackId: 'hanshin_turf_2200_inner',
    trackName: '阪神',
    surface: '芝',
    distance: 2200,
    courseType: '内',
    turnType: '右回り',
    straightLength: 356.5,
    slopeHeight: 1.8,
    slopeDetail: '内回りコースを使用。正面スタンド前の急坂前からスタートし、ゴール前にも急坂。',
    description: '宝塚記念の舞台。梅雨の時期に行われることが多く、荒れた馬場やタフな持続力勝負になりやすい。直線が356.5mと短く、4つのコーナーを回るため、3〜4コーナーで外から豪快に押し上げる機動力とパワー血統（ステイゴールド系、ロベルト系等）が好走。',
    frameBias: {
      inside: 1.06,
      middle: 1.04,
      outside: 0.94,
    },
    styleBias: {
      nige: 1.00,
      senko: 1.20,
      sashi: 1.14,
      oikomi: 0.82,
    },
    heavyTrackStyleShift: {
      frontBonus: 0.14,
    },
    historicalPaceData: {
      frontRunnerWinRate: 11.0,
      frontRunnerPlaceRate: 30.0,
      frontRunner3rdCount: 3,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '3〜6番手（早めのまくり）',
      keyInsight: '宝塚記念はタフな内回り。前が止まらない馬場状態の時は逃げ・先行が残るが、外差し馬場にシフトした時は早めに動いた差し馬の圧勝劇が多い。',
    },
  },

  'chukyo_dirt_1800': {
    trackId: 'chukyo_dirt_1800',
    trackName: '中京',
    surface: 'ダート',
    distance: 1800,
    courseType: '本線',
    turnType: '左回り',
    straightLength: 410.7,
    slopeHeight: 3.4,
    slopeDetail: 'スタンド前直線坂の途中からスタート。直線にも急坂（高低差2.0m、勾配2.0%）。',
    description: 'チャンピオンズカップの舞台。ダートとしては直線が410.7mと長く、ゴール前に急坂があるため、スタミナとタフな底力が問われる。外を回すと距離ロスが大きく、内ラチ沿いで脚を溜めた馬が直線で台頭しやすい。',
    frameBias: {
      inside: 1.14, // 内枠断然有利
      middle: 1.02,
      outside: 0.88,
    },
    styleBias: {
      nige: 1.15,
      senko: 1.25, // 好位イン差し・先行が最強
      sashi: 0.95,
      oikomi: 0.70,
    },
    heavyTrackStyleShift: {
      frontBonus: 0.16,
    },
    historicalPaceData: {
      frontRunnerWinRate: 14.5,
      frontRunnerPlaceRate: 38.0,
      frontRunner3rdCount: 3,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '1〜3番手',
      keyInsight: 'チャンピオンズCでは、内枠（1〜3枠）に入った先行馬がラチ沿いをロスなく立ち回って3着以内に粘るパターンが圧倒的。追込一辺倒の馬は急坂で届かず大敗しやすい。',
    },
  },
};

export function getCourseCharacteristics(trackName: string, surface: string, distance: number): CourseCharacteristics {
  // Find closest course or fallback
  const key = `${trackName}_${surface}_${distance}`.toLowerCase();
  for (const cKey of Object.keys(JRA_COURSES)) {
    const c = JRA_COURSES[cKey];
    if (c.trackName === trackName && c.surface === surface && Math.abs(c.distance - distance) <= 200) {
      return c;
    }
  }

  // Fallback realistic course characteristics
  return {
    trackId: `custom_${trackName}_${surface}_${distance}`,
    trackName,
    surface: surface as any,
    distance,
    turnType: '右回り',
    straightLength: distance > 1600 ? 400 : 350,
    slopeHeight: 2.0,
    slopeDetail: '直線に緩やかな起伏あり。',
    description: `${trackName}${surface}${distance}mの標準コース。展開と枠順のバランスが問われる。`,
    frameBias: { inside: 1.05, middle: 1.0, outside: 0.95 },
    styleBias: { nige: 1.10, senko: 1.15, sashi: 1.05, oikomi: 0.85 },
    heavyTrackStyleShift: { frontBonus: 0.12 },
    historicalPaceData: {
      frontRunnerWinRate: 11.5,
      frontRunnerPlaceRate: 32.0,
      frontRunner3rdCount: 3,
      frontRunnerTotal: 10,
      bestPassingRankTrend: '2〜5番手',
      keyInsight: '標準的な展開では先行勢が安定。馬場悪化時は前残りバイアスが強まる。',
    },
  };
}
