/** Lua-side animation objects keep callbacks and parent keys inside the same sandbox as FrameXML. */
export const GLUE_ANIMATION_PRELUDE = `
do
  local groupsByOwner, active = {}, {}
  local groupMethods, animationMethods = {}, {}
  local function fire(object, script, ...)
    local handler = object.scripts[script]
    if handler then __glueInvoke(handler, object, false, ...) end
  end
  local function changed() __glueAnimationActive(next(active) ~= nil) end
  local function number(value, fallback)
    local parsed = tonumber(value)
    return parsed and parsed == parsed and math.abs(parsed) < math.huge and parsed or fallback
  end
  local origins = {
    TOPLEFT = {-50, -50}, TOP = {0, -50}, TOPRIGHT = {50, -50},
    LEFT = {-50, 0}, CENTER = {0, 0}, RIGHT = {50, 0},
    BOTTOMLEFT = {-50, 50}, BOTTOM = {0, 50}, BOTTOMRIGHT = {50, 50},
  }
  local function atOrigin(animation, operation)
    local point = origins[animation.originPoint] or origins.CENTER
    local before, after = {}, {}
    if point[1] ~= 0 or point[2] ~= 0 then
      before[#before + 1] = string.format("translate(%s%%, %s%%)", point[1], point[2])
      after[#after + 1] = string.format("translate(%s%%, %s%%)", -point[1], -point[2])
    end
    if animation.originX ~= 0 or animation.originY ~= 0 then
      before[#before + 1] = string.format("translate(%spx, %spx)", animation.originX, -animation.originY)
      table.insert(after, 1, string.format("translate(%spx, %spx)", -animation.originX, animation.originY))
    end
    before[#before + 1] = operation
    for _, part in ipairs(after) do before[#before + 1] = part end
    return table.concat(before, " ")
  end
  local function visual(animation, progress)
    if animation.kind == "Translation" then
      local x, y = animation.offsetX * progress, animation.offsetY * progress
      return (x ~= 0 or y ~= 0) and string.format("translate(%spx, %spx)", x, -y) or nil
    end
    if animation.kind == "Rotation" then
      local angle = animation.radians * progress
      return angle ~= 0 and atOrigin(animation, string.format("rotate(%srad)", -angle)) or nil
    end
    if animation.kind == "Scale" then
      local x = 1 + (animation.scaleX - 1) * progress
      local y = 1 + (animation.scaleY - 1) * progress
      return (x ~= 1 or y ~= 1) and atOrigin(animation, string.format("scale(%s, %s)", x, y)) or nil
    end
    return nil
  end
  local function paint(owner)
    local sum, found, transforms = 0, false, {}
    for _, group in ipairs(groupsByOwner[owner] or {}) do
      if group.effect ~= nil then
        sum = sum + group.effect.alpha; found = true
        for _, transform in ipairs(group.effect.transforms) do transforms[#transforms + 1] = transform end
      end
    end
    __glueSetAnimationAlpha(owner, found and math.max(0, math.min(1, owner:GetAlpha() + sum)) or nil)
    __glueSetAnimationTransform(owner, #transforms > 0 and table.concat(transforms, " ") or nil)
  end
  local function timing(group)
    local lengths, orders, starts, duration = {}, {}, {}, 0
    for _, animation in ipairs(group.animations) do
      local order = animation.order
      if lengths[order] == nil then orders[#orders + 1] = order; lengths[order] = 0 end
      lengths[order] = math.max(lengths[order], animation.startDelay + animation.duration + animation.endDelay)
    end
    table.sort(orders)
    for _, order in ipairs(orders) do starts[order] = duration; duration = duration + lengths[order] end
    for _, animation in ipairs(group.animations) do animation.startTime = starts[animation.order] + animation.startDelay end
    group.duration = duration
    return duration
  end
  local function smooth(progress, mode)
    if mode == "IN" then return progress * progress end
    if mode == "OUT" then return 1 - (1 - progress) * (1 - progress) end
    if mode == "IN_OUT" then return progress * progress * (3 - 2 * progress) end
    if mode == "OUT_IN" then
      return progress < .5 and (1 - (1 - progress * 2) ^ 2) / 2
        or (1 + (progress * 2 - 1) ^ 2) / 2
    end
    return progress
  end
  local function sample(group, position, elapsed)
    local effect, transforms = 0, {}
    for _, animation in ipairs(group.animations) do
      local localTime = position - animation.startTime
      local progress = localTime < 0 and 0 or animation.duration == 0 and 1
        or math.max(0, math.min(1, localTime / animation.duration))
      animation.progress = progress
      local eased = smooth(progress, animation.smoothing)
      if animation.kind == "Alpha" then effect = effect + animation.change * eased end
      local transform = visual(animation, eased)
      if transform then transforms[#transforms + 1] = transform end
      if group.playing and localTime >= 0 and not animation.started then
        animation.started = true; fire(animation, "OnPlay")
      end
      if group.playing and localTime >= 0 and localTime < animation.duration then fire(animation, "OnUpdate", elapsed) end
      if group.playing and localTime >= animation.duration and not animation.finished then
        animation.finished = true; fire(animation, "OnFinished", true)
      end
    end
    if group.playing then group.effect = { alpha = effect, transforms = transforms }; paint(group.owner) end
  end
  local function resetChildren(group)
    for _, animation in ipairs(group.animations) do
      animation.started, animation.finished, animation.progress = false, false, 0
    end
  end
  function groupMethods:GetName() return self.name end
  function groupMethods:GetObjectType() return "AnimationGroup" end
  function groupMethods:IsObjectType(kind) return kind == "AnimationGroup" end
  function groupMethods:GetParent() return self.owner end
  function groupMethods:GetRegionParent() return self.owner end
  function groupMethods:GetAnimations() return unpack(self.animations) end
  function groupMethods:GetDuration() return timing(self) end
  function groupMethods:GetElapsed() return self.elapsed end
  function groupMethods:GetProgress() return self.duration > 0 and self.position / self.duration or 0 end
  function groupMethods:IsPlaying() return self.playing end
  function groupMethods:IsPaused() return self.paused end
  function groupMethods:IsStopped() return not self.playing and not self.paused end
  function groupMethods:IsDone() return self.done end
  function groupMethods:GetLooping() return self.looping end
  function groupMethods:SetLooping(value)
    assert(value == "NONE" or value == "REPEAT" or value == "BOUNCE", "unsupported looping mode")
    self.looping = value
  end
  function groupMethods:GetLoopState() return self.reverse and "REVERSE" or "FORWARD" end
  function groupMethods:SetScript(name, handler) self.scripts[name] = handler end
  function groupMethods:GetScript(name) return self.scripts[name] end
  function groupMethods:HasScript(name) return self.scripts[name] ~= nil end
  function groupMethods:HookScript(name, handler)
    local previous = self.scripts[name]
    self.scripts[name] = function(...) if previous then previous(...) end; handler(...) end
  end
  function groupMethods:Play()
    if self.playing then return end
    if not self.paused then self.elapsed, self.position, self.reverse = 0, 0, false; resetChildren(self) end
    self.playing, self.paused, self.done, self.finishing = true, false, false, false
    timing(self); active[self] = true; changed(); fire(self, "OnPlay"); sample(self, self.position, 0)
  end
  function groupMethods:Pause()
    if not self.playing then return end
    self.playing, self.paused = false, true; active[self] = nil; changed(); fire(self, "OnPause")
  end
  function groupMethods:Stop()
    local wasActive = self.playing or self.paused
    self.playing, self.paused, self.done = false, false, false
    self.elapsed, self.position, self.effect = 0, 0, nil
    active[self] = nil; changed(); resetChildren(self); paint(self.owner)
    if wasActive then fire(self, "OnStop", false) end
  end
  function groupMethods:Finish() self.finishing = true end
  function animationMethods:GetName() return self.name end
  function animationMethods:GetObjectType() return self.kind end
  function animationMethods:IsObjectType(kind) return kind == self.kind or kind == "Animation" end
  function animationMethods:GetParent() return self.group end
  function animationMethods:GetRegionParent() return self.group.owner end
  function animationMethods:SetDuration(value) self.duration = math.max(0, tonumber(value) or 0); timing(self.group) end
  function animationMethods:GetDuration() return self.duration end
  function animationMethods:SetStartDelay(value) self.startDelay = math.max(0, tonumber(value) or 0); timing(self.group) end
  function animationMethods:GetStartDelay() return self.startDelay end
  function animationMethods:SetEndDelay(value) self.endDelay = math.max(0, tonumber(value) or 0); timing(self.group) end
  function animationMethods:GetEndDelay() return self.endDelay end
  function animationMethods:SetOrder(value) self.order = math.max(1, math.floor(tonumber(value) or 1)); timing(self.group) end
  function animationMethods:GetOrder() return self.order end
  function animationMethods:SetChange(value) self.change = tonumber(value) or 0 end
  function animationMethods:GetChange() return self.change end
  function animationMethods:SetOffset(x, y)
    assert(self.kind == "Translation", "SetOffset requires Translation")
    self.offsetX, self.offsetY = number(x, 0), number(y, 0)
  end
  function animationMethods:GetOffset() return self.offsetX, self.offsetY end
  function animationMethods:SetDegrees(value)
    assert(self.kind == "Rotation", "SetDegrees requires Rotation")
    self.radians = number(value, 0) * math.pi / 180
  end
  function animationMethods:GetDegrees() return self.radians * 180 / math.pi end
  function animationMethods:SetRadians(value)
    assert(self.kind == "Rotation", "SetRadians requires Rotation")
    self.radians = number(value, 0)
  end
  function animationMethods:GetRadians() return self.radians end
  function animationMethods:SetScale(x, y)
    assert(self.kind == "Scale", "SetScale requires Scale")
    self.scaleX, self.scaleY = number(x, 1), number(y, 1)
  end
  function animationMethods:GetScale() return self.scaleX, self.scaleY end
  function animationMethods:SetOrigin(point, x, y)
    assert(self.kind == "Rotation" or self.kind == "Scale", "SetOrigin requires Rotation or Scale")
    point = tostring(point or "CENTER"):upper()
    assert(origins[point], "unsupported animation origin: " .. point)
    self.originPoint, self.originX, self.originY = point, number(x, 0), number(y, 0)
  end
  function animationMethods:GetOrigin() return self.originPoint, self.originX, self.originY end
  function animationMethods:SetSmoothing(value) self.smoothing = value or "NONE" end
  function animationMethods:GetSmoothing() return self.smoothing end
  function animationMethods:GetProgress() return self.progress end
  function animationMethods:GetElapsed() return math.max(0, math.min(self.duration, self.group.position - self.startTime)) end
  function animationMethods:IsPlaying() return self.group.playing and self.started and not self.finished end
  function animationMethods:IsPaused() return self.group.paused end
  function animationMethods:IsStopped() return self.group:IsStopped() end
  function animationMethods:IsDone() return self.finished end
  function animationMethods:Play() self.group:Play() end
  function animationMethods:Pause() self.group:Pause() end
  function animationMethods:Stop() self.group:Stop() end
  function animationMethods:Finish() self.group:Finish() end
  animationMethods.SetScript, animationMethods.GetScript = groupMethods.SetScript, groupMethods.GetScript
  animationMethods.HasScript, animationMethods.HookScript = groupMethods.HasScript, groupMethods.HookScript
  local function publish(object, name, key, parent)
    if name and name ~= "" then object.name = name; _G[name] = object end
    if key and key ~= "" then parent[key] = object end
  end
  function groupMethods:CreateAnimation(kind, name)
    kind = kind or "Animation"
    assert(kind == "Animation" or kind == "Alpha" or kind == "Translation"
      or kind == "Rotation" or kind == "Scale", "unsupported animation type: " .. tostring(kind))
    local animation = setmetatable({ kind = kind, group = self, duration = 0, startDelay = 0,
      endDelay = 0, order = 1, change = 0, smoothing = "NONE", progress = 0, startTime = 0,
      offsetX = 0, offsetY = 0, radians = 0, scaleX = 1, scaleY = 1,
      originPoint = "CENTER", originX = 0, originY = 0,
      started = false, finished = false, scripts = {} }, { __index = animationMethods })
    self.animations[#self.animations + 1] = animation
    publish(animation, name, nil, self)
    return animation
  end
  local function createGroup(owner, name)
    local group = setmetatable({ owner = owner, animations = {}, scripts = {}, elapsed = 0,
      position = 0, duration = 0, looping = "NONE", playing = false, paused = false,
      done = false, reverse = false }, { __index = groupMethods })
    local groups = groupsByOwner[owner] or {}; groupsByOwner[owner] = groups; groups[#groups + 1] = group
    publish(group, name, nil, owner)
    return group
  end
  local function getGroups(owner) return unpack(groupsByOwner[owner] or {}) end
  local function stopGroups(owner) for _, group in ipairs(groupsByOwner[owner] or {}) do group:Stop() end end
  function __glueHideAnimations(owner) stopGroups(owner) end
  function __glueAttachAnimations(owner)
    owner.CreateAnimationGroup = createGroup
    owner.GetAnimationGroups = getGroups
    owner.StopAnimating = stopGroups
  end
  local function scripts(object, declarations)
    for name, declaration in pairs(declarations or {}) do
      if declaration.func then
        object.scripts[name] = function(...) local fn = _G[declaration.func]; if fn then fn(...) end end
      else
        local parameters = name == "OnUpdate" and "self,elapsed,..." or name == "OnLoop" and "self,loopState,..."
          or (name == "OnFinished" or name == "OnStop") and "self,requested,..." or "self,..."
        local factory, err = loadstring("return function(" .. parameters .. ") " .. declaration.source .. " end", "@animation:" .. (object.name or object:GetObjectType()) .. ":" .. name)
        assert(factory, err); object.scripts[name] = factory()
      end
    end
  end
  function __glueBindAnimations(owner, definitions)
    for _, definition in ipairs(definitions) do
      local group = createGroup(owner, definition.name)
      publish(group, definition.name, definition.parentKey, owner)
      group:SetLooping(definition.looping)
      scripts(group, definition.scripts)
      for _, definition in ipairs(definition.animations) do
        local animation = group:CreateAnimation(definition.kind, definition.name)
        publish(animation, definition.name, definition.parentKey, group)
        animation:SetDuration(definition.duration); animation:SetStartDelay(definition.startDelay)
        animation:SetEndDelay(definition.endDelay); animation:SetOrder(definition.order)
        animation:SetChange(definition.change); animation:SetSmoothing(definition.smoothing)
        if animation.kind == "Translation" then animation:SetOffset(definition.offsetX, definition.offsetY) end
        if animation.kind == "Rotation" then animation:SetRadians(definition.radians) end
        if animation.kind == "Scale" then animation:SetScale(definition.scaleX, definition.scaleY) end
        if animation.kind == "Rotation" or animation.kind == "Scale" then
          animation:SetOrigin(definition.originPoint, definition.originX, definition.originY)
        end
        scripts(animation, definition.scripts); fire(animation, "OnLoad")
      end
      timing(group); fire(group, "OnLoad")
    end
  end
  function __glueTickAnimations(elapsed)
    local snapshot = {}; for group in pairs(active) do snapshot[#snapshot + 1] = group end
    for _, group in ipairs(snapshot) do
      if group.playing then
        local duration = timing(group)
        group.elapsed = group.elapsed + elapsed
        local position = group.position + (group.reverse and -elapsed or elapsed)
        local crossed = duration == 0 or (group.reverse and position <= 0) or (not group.reverse and position >= duration)
        if crossed then
          sample(group, group.reverse and 0 or duration, elapsed)
          if group.playing and (group.looping == "NONE" or group.finishing or duration == 0) then
            group.playing, group.done, group.effect = false, true, nil
            group.position = group.reverse and 0 or duration
            active[group] = nil; paint(group.owner); changed(); fire(group, "OnFinished", true)
          elseif group.playing then
            if group.looping == "BOUNCE" then
              local phase = group.elapsed % (duration * 2)
              group.reverse = phase >= duration
              position = group.reverse and duration * 2 - phase or phase
            else position = group.elapsed % duration end
            resetChildren(group); fire(group, "OnLoop", group:GetLoopState())
          end
        end
        if group.playing then group.position = position; sample(group, position, elapsed); fire(group, "OnUpdate", elapsed) end
      end
    end
  end
  function __glueReleaseAnimations(owner)
    for _, group in ipairs(groupsByOwner[owner] or {}) do group:Stop() end
    groupsByOwner[owner] = nil
  end
end
`;
