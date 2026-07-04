local counter = 0
local seed = os.time()
local uid_base = 1000000

function init(args)
    local thread = tostring({}):match("0x(%x+)")
    if thread then
        seed = seed + tonumber(thread, 16)
    end
    math.randomseed(seed)
    -- orders.user_id is MySQL INT, so keep generated ids below 2,147,483,647.
    uid_base = math.random(1, 1800) * 1000000 + (seed % 1000) * 1000
end

local function base_path()
    if wrk.path == nil or wrk.path == "" or wrk.path == "/" then
        return "/lucky"
    end
    return wrk.path
end

function request()
    counter = counter + 1
    local uid = uid_base + counter
    local path = base_path()
    local separator = string.find(path, "?", 1, true) and "&" or "?"
    return wrk.format("GET", path .. separator .. "uid=" .. uid)
end
