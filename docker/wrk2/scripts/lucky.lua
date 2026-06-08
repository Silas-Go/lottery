local counter = 0
local seed = os.time()

function init(args)
    local thread = tostring({}):match("0x(%x+)")
    if thread then
        seed = seed + tonumber(thread, 16)
    end
    math.randomseed(seed)
end

local function base_path()
    if wrk.path == nil or wrk.path == "" or wrk.path == "/" then
        return "/lucky"
    end
    return wrk.path
end

function request()
    counter = counter + 1
    local uid = math.random(100000, 999999) * 1000000 + counter
    local path = base_path()
    local separator = string.find(path, "?", 1, true) and "&" or "?"
    return wrk.format("GET", path .. separator .. "uid=" .. uid)
end
