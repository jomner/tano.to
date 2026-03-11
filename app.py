from flask import Flask, render_template

app = Flask(__name__)

# ── Register Blueprints ────────────────────────────────────────────────────

from photoglobe import photoglobe_bp
app.register_blueprint(photoglobe_bp)

# ── Project data ───────────────────────────────────────────────────────────
# Add a new dict here for each project.
# Fields: title, description, tags (list), url, thumbnail (filename in /static/assets/)

PROJECTS = [
    {
        "title": "Photoglobe",
        "description": "Interactive 3D globe for displaying geotagged stereo photographs.",
        "tags": ["web", "photography"],
        "url": "/photoglobe",
        "thumbnail": "projects/photoglobe_thumbnail.webp"
    },
]

# ── Routes ─────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/projects')
def projects():
    return render_template('projects.html', projects=PROJECTS)

@app.route('/media')
def media():
    return render_template('media.html')

@app.route('/blog')
def blog():
    return render_template('blog.html')

@app.route('/dreams')
def dreams():
    return render_template('dreams.html')

@app.route('/misc')
def misc():
    return render_template('misc.html')

@app.route('/about')
def about():
    return render_template('about.html')

if __name__ == '__main__':
    app.run(debug=True)