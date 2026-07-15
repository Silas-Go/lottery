-- 第一章只读取固定职业档案，不生成 uid，也不改变任何订单或库存状态。
-- wrk2 会使用 TARGET_URL 中的原始路径，保证直读和 Cache-Aside 两轮实验只有读取路径不同。
function request()
    return wrk.format("GET", wrk.path)
end
