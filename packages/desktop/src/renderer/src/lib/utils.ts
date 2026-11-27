import { createCn } from "cn/config";

/** Class merging that knows the type scale in styles.css (`text-body` etc. are font sizes, not colours). */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "stat", "heading", "section", "lead", "body", "meta", "micro"] }],
    },
  },
});
