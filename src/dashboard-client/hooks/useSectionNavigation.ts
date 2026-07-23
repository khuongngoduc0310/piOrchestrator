import { useEffect, useState } from "react";

export function useSectionNavigation(visible: boolean): string | null {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setCurrent(null);
      return;
    }

    const sections = document.querySelectorAll<HTMLElement>("section[id]");
    if (!sections.length) return;

    let observer: IntersectionObserver | null = null;

    try {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setCurrent(entry.target.id);
              return;
            }
          }
        },
        { rootMargin: "-60px 0px -60% 0px" },
      );
    } catch {
      return;
    }

    sections.forEach((s) => observer!.observe(s));
    return () => observer!.disconnect();
  }, [visible]);

  return current;
}
