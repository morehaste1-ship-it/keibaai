import { useEffect, useRef, useState } from 'react';

/**
 * 要素が画面に近づいたら true になる（一度 true になったら戻らない）。
 * ページの下のほうにある重い欄（答え合わせなど）を、見るときだけ読み込むために使う。
 * 開いた直後はレースなどの内容がまだ無くページが短いため、どの欄も画面内に見えてしまう。
 * そこで startDelayMs だけ待って、ページの内容がそろってから見張りを始める
 */
export function useNearViewport<T extends Element>(rootMargin = '300px', startDelayMs = 2000): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    const timer = setTimeout(() => io.observe(el), startDelayMs);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [near, rootMargin, startDelayMs]);
  return [ref, near];
}
