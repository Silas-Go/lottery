(function (global) {
    "use strict";

    // 所有覆盖层坐标都以 market-street-bg.svg 的 1440×900 画布百分比为基准。
    // 替换背景资产时只需重新标定这里；页面结构和动画脚本不应再出现散落的 left/top。
    var elements = Object.freeze({
        seckillShop: { x: 0, y: 7, width: 35, height: 93 },
        archiveShop: { x: 65, y: 8, width: 35, height: 92 },
        submitSlot: { x: 8.2, y: 47.5, width: 15.2, height: 7.2 },
        resultSlot: { x: 8.2, y: 63.5, width: 15.2, height: 7.2 },
        seckillStatus: { x: 6.5, y: 87.5, width: 20, height: 6.2 },
        seckillRibbon: { x: 2.2, y: 33.8, width: 17, height: 3.8 },
        queue1: { x: 27.5, y: 74, width: 2.1, height: 8.2, scale: 1 },
        queue2: { x: 31, y: 69, width: 1.9, height: 7.6, scale: .93 },
        queue3: { x: 34, y: 65, width: 1.8, height: 7.1, scale: .86 },
        queue4: { x: 36.8, y: 61, width: 1.7, height: 6.6, scale: .79 },
        queue5: { x: 39.2, y: 57.5, width: 1.6, height: 6.1, scale: .72 },
        queue6: { x: 41.5, y: 54.2, width: 1.5, height: 5.7, scale: .66 },
        queue7: { x: 37.2, y: 52.4, width: 1.45, height: 5.4, scale: .62 },
        queue8: { x: 34.2, y: 50.2, width: 1.35, height: 5.1, scale: .58 },
        queue9: { x: 40.4, y: 48, width: 1.3, height: 4.8, scale: .54 },
        queue10: { x: 43, y: 45.5, width: 1.25, height: 4.6, scale: .5 },
        walker1: { x: 47.5, y: 40.5, width: .95, height: 3.8, scale: .88 },
        walker2: { x: 57.8, y: 46, width: .9, height: 3.6, scale: .82 },
        walker3: { x: 53.4, y: 35.6, width: .8, height: 3.2, scale: .74 }
    });

    var particles = Object.freeze([
        { x: 8, y: 22, size: 2, opacity: .34, duration: 7.1, delay: -1.2 },
        { x: 15, y: 53, size: 1, opacity: .48, duration: 8.4, delay: -3.4 },
        { x: 21, y: 31, size: 2, opacity: .3, duration: 6.5, delay: -2.1 },
        { x: 28, y: 62, size: 2, opacity: .42, duration: 9.2, delay: -5.7 },
        { x: 33, y: 18, size: 1, opacity: .5, duration: 7.8, delay: -4.1 },
        { x: 39, y: 47, size: 2, opacity: .35, duration: 6.8, delay: -1.7 },
        { x: 44, y: 72, size: 3, opacity: .32, duration: 9.6, delay: -6.2 },
        { x: 49, y: 27, size: 1, opacity: .54, duration: 7.3, delay: -3.8 },
        { x: 53, y: 58, size: 2, opacity: .39, duration: 8.7, delay: -2.5 },
        { x: 57, y: 39, size: 2, opacity: .44, duration: 6.9, delay: -5.1 },
        { x: 62, y: 77, size: 3, opacity: .28, duration: 9.8, delay: -4.6 },
        { x: 66, y: 24, size: 1, opacity: .5, duration: 7.7, delay: -2.8 },
        { x: 70, y: 51, size: 2, opacity: .36, duration: 8.9, delay: -6.5 },
        { x: 74, y: 68, size: 2, opacity: .41, duration: 7.2, delay: -1.9 },
        { x: 79, y: 34, size: 1, opacity: .55, duration: 6.6, delay: -4.3 },
        { x: 83, y: 59, size: 3, opacity: .29, duration: 9.4, delay: -3.1 },
        { x: 87, y: 19, size: 1, opacity: .48, duration: 7.5, delay: -5.9 },
        { x: 91, y: 46, size: 2, opacity: .38, duration: 8.2, delay: -2.3 },
        { x: 12, y: 79, size: 2, opacity: .32, duration: 9.1, delay: -7.1 },
        { x: 36, y: 84, size: 1, opacity: .46, duration: 7.9, delay: -3.6 },
        { x: 59, y: 14, size: 2, opacity: .31, duration: 8.6, delay: -5.4 },
        { x: 95, y: 73, size: 1, opacity: .5, duration: 7, delay: -4.8 }
    ]);

    global.SilasMarketSceneConfig = Object.freeze({
        designSize: Object.freeze({ width: 1440, height: 900 }),
        elements: elements,
        particles: particles
    });
}(window));
