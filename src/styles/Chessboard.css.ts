import { globalStyle, style } from "@vanilla-extract/css";
import { vars } from "./theme";

export const chessboard = style({
    position: "relative",
    flex: 1,
    zIndex: 1,
    display: "flex",
    aspectRatio: "1",
});

globalStyle(`${chessboard} > .cg-wrap > cg-container > cg-board > square.last-move`, {
    [vars.darkSelector]: {
        backgroundColor:
            "color-mix(in srgb, var(--light-color, var(--mantine-primary-color-5)) 40%, transparent)",
    },
    [vars.lightSelector]: {
        backgroundColor:
            "color-mix(in srgb, var(--dark-color, var(--mantine-primary-color-3)) 40%, transparent)",
    },
});

// Explanation panel's "previewing a candidate/PV, not the real position" tint --
// chessground's own square-highlight layer (same mechanism as last-move above) renders
// behind pieces, unlike an overlay Box would, so the tinted squares stay visible
// without dimming the pieces sitting on them.
globalStyle(`${chessboard} > .cg-wrap > cg-container > cg-board > square.preview-tint`, {
    backgroundColor: "color-mix(in srgb, var(--mantine-color-blue-5) 12%, transparent)",
});

export const blindfold = style({});
globalStyle(`${blindfold} piece`, {
    opacity: 0,
});

globalStyle(`${blindfold} square.check`, {
    backgroundImage: "none",
});
