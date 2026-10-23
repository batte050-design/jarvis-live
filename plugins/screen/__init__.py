"""Put things on the user's screen - registration."""
from . import schemas, tools


def register(ctx):
    ctx.register_tool(name="screen_show", toolset="screen",
                      schema=schemas.SCREEN_SHOW, handler=tools.screen_show)
    ctx.register_tool(name="screen_clear", toolset="screen",
                      schema=schemas.SCREEN_CLEAR, handler=tools.screen_clear)
