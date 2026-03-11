from flask import Blueprint

# Register Photoglobe as a Blueprint mounted at /photoglobe
# Its own static files live in photoglobe/static/
# Its own templates live in photoglobe/templates/
photoglobe_bp = Blueprint(
    'photoglobe',
    __name__,
    static_folder='static',
    template_folder='templates',
    url_prefix='/photoglobe'
)

from . import routes